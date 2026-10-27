import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { ConflictError, InsufficientFundsError, NotFoundError } from "../../domain/errors.js";
import { assertPositiveInteger } from "../../domain/policies.js";
import { inSerializableTransaction } from "../shared/transaction.js";

export class WalletUseCases {
  constructor(private readonly database: PrismaClient) {}

  async redeemLoyalty(userId: string, points: number) {
    assertPositiveInteger(points, "points");
    return inSerializableTransaction(this.database, async (transaction) => {
      const user = await transaction.user.findUnique({ where: { id: userId } });
      if (!user || user.loyaltyPoints < points) {
        throw new ConflictError("Insufficient loyalty points");
      }
      const lots = await transaction.loyaltyLot.findMany({
        where: { userId, expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: "asc" },
      });

      let remaining = points;
      for (const lot of lots) {
        const used = Math.min(remaining, lot.points);
        if (used > 0) {
          const updated = await transaction.loyaltyLot.updateMany({
            where: { id: lot.id, points: { gte: used } },
            data: { points: { decrement: used } },
          });
          if (updated.count !== 1) throw new ConflictError("Loyalty points changed concurrently");
          remaining -= used;
        }
        if (remaining === 0) break;
      }
      if (remaining > 0) throw new ConflictError("Insufficient unexpired loyalty points");

      const updatedUser = await transaction.user.updateMany({
        where: { id: userId, loyaltyPoints: { gte: points } },
        data: { loyaltyPoints: { decrement: points } },
      });
      if (updatedUser.count !== 1) throw new ConflictError("Loyalty points changed concurrently");
      const wallet = await transaction.wallet.findUnique({
        where: { userId_currency: { userId, currency: "USD" } },
      });
      if (!wallet) throw new NotFoundError("Wallet");

      await transaction.wallet.update({
        where: { id: wallet.id },
        data: { balanceCents: { increment: points } },
      });
      await transaction.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          amountCents: points,
          currency: wallet.currency,
          kind: "LOYALTY_REDEMPTION",
          reference: randomUUID(),
        },
      });
      return { pointsRedeemed: points, creditCents: points };
    });
  }

  async transfer(input: {
    fromWalletId: string;
    toWalletId: string;
    amountCents: number;
    idempotencyKey: string;
  }) {
    assertPositiveInteger(input.amountCents, "amountCents");
    if (input.fromWalletId === input.toWalletId) {
      throw new ConflictError("Cannot transfer to the same wallet");
    }
    const requestHash = createHash("sha256")
      .update(JSON.stringify([input.fromWalletId, input.toWalletId, input.amountCents]))
      .digest("hex");

    return inSerializableTransaction(this.database, async (transaction) => {
      const prior = await transaction.idempotencyRecord.findUnique({
        where: { key: input.idempotencyKey },
      });
      if (prior) {
        if (prior.operation !== "wallet.transfer") {
          throw new ConflictError("Idempotency key was already used for another operation");
        }
        if (prior.requestHash !== requestHash) {
          throw new ConflictError("Idempotency key was reused with a different transfer request");
        }
        return prior.response;
      }

      const wallets = await transaction.wallet.findMany({
        where: { id: { in: [input.fromWalletId, input.toWalletId] } },
      });
      if (wallets.length !== 2) throw new NotFoundError("Wallet");
      const source = wallets.find((wallet) => wallet.id === input.fromWalletId)!;
      const destination = wallets.find((wallet) => wallet.id === input.toWalletId)!;
      if (source.currency !== destination.currency) {
        throw new ConflictError("Wallet currencies must match");
      }

      const debited = await transaction.$executeRaw`
        UPDATE "Wallet"
        SET "balanceCents" = "balanceCents" - ${input.amountCents}
        WHERE id = ${source.id}::uuid
          AND "balanceCents" >= ${input.amountCents}
      `;
      if (debited !== 1) throw new InsufficientFundsError();
      await transaction.wallet.update({
        where: { id: destination.id },
        data: { balanceCents: { increment: input.amountCents } },
      });

      const reference = randomUUID();
      await transaction.ledgerEntry.createMany({
        data: [
          {
            walletId: source.id,
            amountCents: -input.amountCents,
            currency: source.currency,
            kind: "TRANSFER_OUT",
            reference,
            idempotencyKey: `${input.idempotencyKey}:out`,
          },
          {
            walletId: destination.id,
            amountCents: input.amountCents,
            currency: source.currency,
            kind: "TRANSFER_IN",
            reference,
            idempotencyKey: `${input.idempotencyKey}:in`,
          },
        ],
      });
      const response = {
        reference,
        amountCents: input.amountCents,
        currency: source.currency,
      };
      await transaction.idempotencyRecord.create({
        data: {
          key: input.idempotencyKey,
          operation: "wallet.transfer",
          requestHash,
          response,
        },
      });
      return response;
    });
  }
}
