import { Prisma, PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError } from "../../domain/errors.js";
import { inSerializableTransaction } from "../shared/transaction.js";

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const BILLING_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export class SubscriptionUseCases {
  constructor(private readonly database: PrismaClient) {}

  async renew(subscriptionId: string) {
    return inSerializableTransaction(this.database, async (transaction) => {
      const subscription = await transaction.subscription.findUnique({
        where: { id: subscriptionId },
      });
      if (!subscription) throw new NotFoundError("Subscription");
      if (subscription.status === "CANCELLED") {
        throw new ConflictError("Cancelled subscription cannot be renewed");
      }

      const now = new Date();
      if (subscription.status === "ACTIVE" && subscription.nextBillingAt > now) {
        throw new ConflictError("Subscription is not due for renewal");
      }
      const wallet = await transaction.wallet.findUnique({
        where: {
          userId_currency: {
            userId: subscription.userId,
            currency: subscription.currency,
          },
        },
      });
      if (!wallet) throw new NotFoundError("Wallet");

      const debited = await transaction.$executeRaw`
        UPDATE "Wallet"
        SET "balanceCents" = "balanceCents" - ${subscription.amountCents}
        WHERE id = ${wallet.id}::uuid
          AND "balanceCents" >= ${subscription.amountCents}
      `;
      if (debited !== 1) return this.applyGracePeriod(transaction, subscription, now);

      await transaction.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          amountCents: -subscription.amountCents,
          currency: wallet.currency,
          kind: "SUBSCRIPTION_RENEWAL",
          reference: subscription.id,
        },
      });
      const nextBillingAt = new Date(
        Math.max(subscription.nextBillingAt.getTime(), now.getTime()) + BILLING_PERIOD_MS,
      );
      await transaction.subscription.update({
        where: { id: subscriptionId },
        data: {
          status: "ACTIVE",
          graceUntil: null,
          lastRenewedAt: now,
          nextBillingAt,
        },
      });
      return { status: "ACTIVE" as const, nextBillingAt };
    });
  }

  private async applyGracePeriod(
    transaction: Prisma.TransactionClient,
    subscription: Prisma.SubscriptionGetPayload<object>,
    now: Date,
  ) {
    const graceUntil = subscription.graceUntil ?? new Date(now.getTime() + GRACE_PERIOD_MS);
    if (graceUntil <= now) {
      await transaction.subscription.update({
        where: { id: subscription.id },
        data: { status: "CANCELLED" },
      });
      return { status: "CANCELLED" as const };
    }

    await transaction.subscription.update({
      where: { id: subscription.id },
      data: { status: "PAST_DUE", graceUntil },
    });
    return { status: "PAST_DUE" as const, graceUntil };
  }
}
