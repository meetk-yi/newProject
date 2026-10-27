import { Prisma, PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { OrderAggregate } from "../domain/order.js";
import { Money } from "../domain/money.js";
import {
  calculateBillableWeight,
  calculateDiscount,
  calculateTax,
  assertPositiveInteger,
} from "../domain/policies.js";
import { ConflictError, DomainError, InsufficientFundsError, NotFoundError } from "../domain/errors.js";

type CheckoutInput = {
  userId: string; items: Array<{ productId: string; quantity: number; warehouse?: string | undefined }>;
  discountCodes?: string[] | undefined; payment: { method: "wallet" | "card"; walletId?: string | undefined };
};

export class CommerceService {
  constructor(private readonly db: PrismaClient) {}

  private async prepareCheckout(tx: Prisma.TransactionClient, input: CheckoutInput) {
    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user) throw new NotFoundError("User");
    const requested = new Map<string, { productId: string; warehouse: string; quantity: number }>();
    for (const item of input.items) {
      assertPositiveInteger(item.quantity, "quantity");
      const warehouse = item.warehouse ?? "default";
      const key = `${item.productId}:${warehouse}`;
      const previous = requested.get(key);
      requested.set(key, {
        productId: item.productId,
        warehouse,
        quantity: (previous?.quantity ?? 0) + item.quantity,
      });
    }
    const productIds = [...new Set([...requested.values()].map(({ productId }) => productId))];
    const products = await tx.product.findMany({ where: { id: { in: productIds }, active: true } });
    if (products.length !== productIds.length) throw new NotFoundError("Product");
    const productById = new Map(products.map((product) => [product.id, product]));
    let subtotal = 0;
    for (const item of requested.values()) {
      const product = productById.get(item.productId)!;
      const changed = await tx.$executeRaw`UPDATE "Inventory" SET "onHand" = "onHand" - ${item.quantity} WHERE "productId" = ${item.productId}::uuid AND warehouse = ${item.warehouse} AND "onHand" - "reserved" >= ${item.quantity}`;
      if (changed !== 1) throw new ConflictError(`Insufficient stock for ${product.sku} in ${item.warehouse}`);
      subtotal += product.priceCents * item.quantity;
    }
    return { user, requested, productById, subtotal };
  }

  private async applyDiscounts(
    tx: Prisma.TransactionClient,
    userTier: string,
    codes: string[],
    subtotal: number,
  ): Promise<number> {
    let discountCents = 0;
    for (const [index, code] of codes.entries()) {
      const discount = await tx.discount.findUnique({ where: { code } });
      if (!discount || !discount.active || (discount.expiresAt && discount.expiresAt <= new Date()) ||
          (discount.maxUses !== null && discount.uses >= discount.maxUses) ||
          (discount.allowedTiers.length > 0 && !discount.allowedTiers.includes(userTier))) {
        throw new ConflictError(`Discount ${code} is not valid`);
      }
      if (index > 0 && (!discount.stackable ||
          !(await tx.discount.findUniqueOrThrow({ where: { code: codes[index - 1]! } })).stackable)) {
        throw new ConflictError("Discounts cannot be combined");
      }
      discountCents += calculateDiscount(subtotal, discount.percentOff, discount.minimumCents);
      const usage = await tx.discount.updateMany({
        where: {
          id: discount.id,
          active: true,
          ...(discount.maxUses === null ? {} : { uses: { lt: discount.maxUses } }),
        },
        data: { uses: { increment: 1 } },
      });
      if (usage.count !== 1) throw new ConflictError(`Discount ${code} usage limit was reached`);
    }
    return Math.min(discountCents, subtotal);
  }

  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.db.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const isSerializationConflict = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
        if (!isSerializationConflict || attempt >= 2) throw error;
      }
    }
  }

  async checkout(input: CheckoutInput) {
    if (input.payment.method === "card") {
      throw new DomainError("Card payment provider is not configured", "PAYMENT_PROVIDER_UNAVAILABLE", 503);
    }
    return this.serializable(async (tx) => {
      const { user, requested, productById, subtotal } = await this.prepareCheckout(tx, input);
      const discountCents = await this.applyDiscounts(tx, user.tier, input.discountCodes ?? [], subtotal);
      const taxCents = calculateTax(subtotal - discountCents);
      const totalCents = subtotal - discountCents + taxCents;
      const aggregate = OrderAggregate.place({
        userId: input.userId,
        subtotal: Money.of(subtotal),
        discount: Money.of(discountCents),
        tax: Money.of(taxCents),
      });
      const order = await tx.order.create({
        data: {
          id: aggregate.id, userId: input.userId, subtotalCents: subtotal, discountCents, taxCents, totalCents: aggregate.total.cents,
          lines: { create: [...requested.values()].map((item) => ({
            productId: item.productId, warehouse: item.warehouse, quantity: item.quantity,
            unitPriceCents: productById.get(item.productId)!.priceCents,
          })) },
        },
        include: { lines: true },
      });
      for (const event of aggregate.pullEvents()) {
        await tx.outboxEvent.create({
          data: { type: event.type, aggregateId: event.aggregateId, payload: event.payload },
        });
      }
      if (input.payment.method === "wallet") {
        if (!input.payment.walletId) throw new ConflictError("walletId is required for wallet payment");
        const wallet = await tx.wallet.findUnique({ where: { id: input.payment.walletId } });
        if (!wallet) throw new NotFoundError("Wallet");
        if (wallet.userId !== input.userId) throw new ConflictError("Payment wallet does not belong to the ordering user");
        const changed = await tx.$executeRaw`UPDATE "Wallet" SET "balanceCents" = "balanceCents" - ${totalCents} WHERE id = ${wallet.id}::uuid AND "balanceCents" >= ${totalCents}`;
        if (changed !== 1) throw new InsufficientFundsError();
        await tx.ledgerEntry.create({ data: {
          walletId: wallet.id, amountCents: -totalCents, currency: wallet.currency,
          kind: "ORDER_PAYMENT", reference: order.id,
        } });
      }
      return order;
    });
  }

  async refund(orderId: string, amountCents: number, reason: string) {
    return this.serializable(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { lines: true } });
      if (!order) throw new NotFoundError("Order");
      if (order.status === "DISPUTED") throw new ConflictError("A disputed order cannot be refunded");
      const aggregate = OrderAggregate.place({
        id: order.id,
        userId: order.userId,
        subtotal: Money.of(order.subtotalCents),
        discount: Money.of(order.discountCents),
        tax: Money.of(order.taxCents),
      });
      if (order.refundedCents > 0) {
        aggregate.refund(Money.of(order.refundedCents));
        aggregate.pullEvents();
      }
      aggregate.refund(Money.of(amountCents));
      const next = aggregate.refunded.cents;
      const updated = await tx.order.updateMany({
        where: { id: orderId, refundedCents: order.refundedCents },
        data: { refundedCents: next, status: next === order.totalCents ? "REFUNDED" : "PARTIALLY_REFUNDED" },
      });
      if (updated.count !== 1) throw new ConflictError("Order refund changed concurrently; retry the request");
      await tx.refund.create({ data: { orderId, amountCents, reason } });
      for (const event of aggregate.pullEvents()) {
        await tx.outboxEvent.create({
          data: { type: event.type, aggregateId: event.aggregateId, payload: event.payload },
        });
      }
      const payment = await tx.ledgerEntry.findFirst({ where: { reference: orderId, kind: "ORDER_PAYMENT" } });
      if (payment) {
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: payment.walletId } });
        await tx.wallet.update({ where: { id: wallet.id }, data: { balanceCents: { increment: amountCents } } });
        await tx.ledgerEntry.create({ data: {
          walletId: wallet.id, amountCents, currency: wallet.currency, kind: "ORDER_REFUND", reference: orderId,
        } });
      }
      if (next === order.totalCents) {
        for (const line of order.lines) {
          await tx.inventory.update({
            where: { productId_warehouse: { productId: line.productId, warehouse: line.warehouse } },
            data: { onHand: { increment: line.quantity } },
          });
        }
      }
      return { orderId, refundedCents: next, status: aggregate.state };
    });
  }

  async allocate(productId: string, warehouse: string, quantity: number, ttlSeconds: number) {
    assertPositiveInteger(quantity, "quantity");
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    return this.serializable(async (tx) => {
      const expired = await tx.allocation.findMany({
        where: { productId, warehouse, releasedAt: null, expiresAt: { lte: new Date() } },
      });
      for (const allocation of expired) {
        const claimed = await tx.allocation.updateMany({
          where: { id: allocation.id, releasedAt: null },
          data: { releasedAt: new Date() },
        });
        if (claimed.count === 1) {
          await tx.inventory.update({
            where: { productId_warehouse: { productId, warehouse } },
            data: { reserved: { decrement: allocation.quantity } },
          });
        }
      }
      const allocated = await tx.$executeRaw`UPDATE "Inventory" SET "reserved" = "reserved" + ${quantity} WHERE "productId" = ${productId}::uuid AND warehouse = ${warehouse} AND "onHand" - "reserved" >= ${quantity}`;
      if (allocated !== 1) throw new ConflictError("Insufficient available inventory");
      return tx.allocation.create({ data: { productId, warehouse, quantity, expiresAt } });
    });
  }

  async validateDiscount(input: { userId: string; subtotalCents: number; codes: string[] }) {
    const user = await this.db.user.findUnique({ where: { id: input.userId } });
    if (!user) throw new NotFoundError("User");
    const discounts = await this.db.discount.findMany({ where: { code: { in: input.codes } } });
    if (discounts.length !== input.codes.length) throw new ConflictError("One or more discount codes do not exist");
    let discountCents = 0;
    for (const [index, code] of input.codes.entries()) {
      const discount = discounts.find((candidate) => candidate.code === code)!;
      if (!discount.active || (discount.expiresAt && discount.expiresAt <= new Date()) ||
          (discount.maxUses !== null && discount.uses >= discount.maxUses) ||
          (discount.allowedTiers.length && !discount.allowedTiers.includes(user.tier))) {
        throw new ConflictError(`Discount ${code} is not valid for this user`);
      }
      if (index > 0 && (!discount.stackable || !discounts.find((candidate) => candidate.code === input.codes[index - 1])?.stackable)) {
        throw new ConflictError("Discounts cannot be combined");
      }
      discountCents += calculateDiscount(input.subtotalCents, discount.percentOff, discount.minimumCents);
    }
    return { valid: true, discountCents: Math.min(discountCents, input.subtotalCents), totalCents: input.subtotalCents - Math.min(discountCents, input.subtotalCents) };
  }

  async redeemLoyalty(userId: string, points: number) {
    assertPositiveInteger(points, "points");
    return this.serializable(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || user.loyaltyPoints < points) throw new ConflictError("Insufficient loyalty points");
      const now = new Date();
      const lots = await tx.loyaltyLot.findMany({
        where: { userId, expiresAt: { gt: now } }, orderBy: { expiresAt: "asc" },
      });
      let remaining = points;
      for (const lot of lots) {
        const used = Math.min(remaining, lot.points);
        if (used > 0) await tx.loyaltyLot.update({ where: { id: lot.id }, data: { points: { decrement: used } } });
        remaining -= used;
        if (remaining === 0) break;
      }
      if (remaining > 0) throw new ConflictError("Insufficient unexpired loyalty points");
      await tx.user.update({ where: { id: userId }, data: { loyaltyPoints: { decrement: points } } });
      const wallet = await tx.wallet.findUnique({ where: { userId_currency: { userId, currency: "USD" } } });
      if (!wallet) throw new NotFoundError("Wallet");
      const cents = points;
      await tx.wallet.update({ where: { id: wallet.id }, data: { balanceCents: { increment: cents } } });
      await tx.ledgerEntry.create({ data: {
        walletId: wallet.id, amountCents: cents, currency: wallet.currency, kind: "LOYALTY_REDEMPTION", reference: randomUUID(),
      } });
      return { pointsRedeemed: points, creditCents: cents };
    });
  }

  async transfer(input: { fromWalletId: string; toWalletId: string; amountCents: number; idempotencyKey: string }) {
    assertPositiveInteger(input.amountCents, "amountCents");
    if (input.fromWalletId === input.toWalletId) throw new ConflictError("Cannot transfer to the same wallet");
    const requestHash = createHash("sha256")
      .update(JSON.stringify([input.fromWalletId, input.toWalletId, input.amountCents]))
      .digest("hex");
    return this.serializable(async (tx) => {
      const prior = await tx.idempotencyRecord.findUnique({ where: { key: input.idempotencyKey } });
      if (prior) {
        if (prior.operation !== "wallet.transfer") throw new ConflictError("Idempotency key was already used for another operation");
        if (prior.requestHash !== requestHash) throw new ConflictError("Idempotency key was reused with a different transfer request");
        return prior.response;
      }
      const wallets = await tx.wallet.findMany({ where: { id: { in: [input.fromWalletId, input.toWalletId] } } });
      if (wallets.length !== 2) throw new NotFoundError("Wallet");
      const source = wallets.find((wallet) => wallet.id === input.fromWalletId)!;
      const destination = wallets.find((wallet) => wallet.id === input.toWalletId)!;
      if (source.currency !== destination.currency) throw new ConflictError("Wallet currencies must match");
      const debited = await tx.$executeRaw`UPDATE "Wallet" SET "balanceCents" = "balanceCents" - ${input.amountCents} WHERE id = ${source.id}::uuid AND "balanceCents" >= ${input.amountCents}`;
      if (debited !== 1) throw new InsufficientFundsError();
      await tx.wallet.update({ where: { id: destination.id }, data: { balanceCents: { increment: input.amountCents } } });
      const reference = randomUUID();
      await tx.ledgerEntry.createMany({ data: [
        { walletId: source.id, amountCents: -input.amountCents, currency: source.currency, kind: "TRANSFER_OUT", reference, idempotencyKey: `${input.idempotencyKey}:out` },
        { walletId: destination.id, amountCents: input.amountCents, currency: source.currency, kind: "TRANSFER_IN", reference, idempotencyKey: `${input.idempotencyKey}:in` },
      ] });
      const response = { reference, amountCents: input.amountCents, currency: source.currency };
      await tx.idempotencyRecord.create({
        data: { key: input.idempotencyKey, operation: "wallet.transfer", requestHash, response },
      });
      return response;
    });
  }

  async generateInvoice(orderId: string) {
    return this.db.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundError("Order");
      const invoice = await tx.invoice.upsert({
        where: { orderId }, create: { orderId }, update: { status: "PENDING" },
      });
      await tx.outboxEvent.create({ data: {
        type: "invoice.generation.requested", aggregateId: invoice.id,
        payload: { invoiceId: invoice.id, orderId: order.id, totalCents: order.totalCents, currency: order.currency },
      } });
      return { invoiceId: invoice.id, status: invoice.status };
    });
  }

  async renewSubscription(subscriptionId: string) {
    return this.serializable(async (tx) => {
      const subscription = await tx.subscription.findUnique({ where: { id: subscriptionId } });
      if (!subscription) throw new NotFoundError("Subscription");
      if (subscription.status === "CANCELLED") throw new ConflictError("Cancelled subscription cannot be renewed");
      const now = new Date();
      if (subscription.status === "ACTIVE" && subscription.nextBillingAt > now) {
        throw new ConflictError("Subscription is not due for renewal");
      }
      const wallet = await tx.wallet.findUnique({ where: { userId_currency: { userId: subscription.userId, currency: subscription.currency } } });
      if (!wallet) throw new NotFoundError("Wallet");
      const debit = await tx.$executeRaw`UPDATE "Wallet" SET "balanceCents" = "balanceCents" - ${subscription.amountCents} WHERE id = ${wallet.id}::uuid AND "balanceCents" >= ${subscription.amountCents}`;
      if (debit !== 1) {
        const graceUntil = subscription.graceUntil ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        if (graceUntil <= now) {
          await tx.subscription.update({ where: { id: subscriptionId }, data: { status: "CANCELLED" } });
          return { status: "CANCELLED" };
        }
        await tx.subscription.update({ where: { id: subscriptionId }, data: { status: "PAST_DUE", graceUntil } });
        return { status: "PAST_DUE", graceUntil };
      }
      await tx.ledgerEntry.create({ data: {
        walletId: wallet.id, amountCents: -subscription.amountCents, currency: wallet.currency,
        kind: "SUBSCRIPTION_RENEWAL", reference: subscription.id,
      } });
      const nextBillingAt = new Date(Math.max(subscription.nextBillingAt.getTime(), now.getTime()) + 30 * 24 * 60 * 60 * 1000);
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: { status: "ACTIVE", graceUntil: null, lastRenewedAt: new Date(), nextBillingAt },
      });
      return { status: "ACTIVE", nextBillingAt };
    });
  }

  async calculateShipping(input: { items: Array<{ productId: string; quantity: number }> }) {
    const ids = input.items.map((item) => item.productId);
    const products = await this.db.product.findMany({ where: { id: { in: ids }, active: true } });
    if (products.length !== new Set(ids).size) throw new NotFoundError("Product");
    const byId = new Map(products.map((product) => [product.id, product]));
    let billableWeight = 0;
    for (const item of input.items) {
      assertPositiveInteger(item.quantity, "quantity");
      const product = byId.get(item.productId)!;
      billableWeight += calculateBillableWeight(product.weightGrams, product.lengthCm, product.widthCm, product.heightCm) * item.quantity;
    }
    const rates = [
      { carrier: "ParcelOne", service: "ground", amountCents: 500 + Math.ceil(billableWeight / 1000) * 125 },
      { carrier: "AirSwift", service: "express", amountCents: 1200 + Math.ceil(billableWeight / 500) * 210 },
    ];
    await this.db.shipmentQuote.createMany({ data: rates.map((rate) => ({ ...rate, billableWeightGrams: billableWeight })) });
    return { billableWeightGrams: billableWeight, rates };
  }

  async openDispute(input: { orderId: string; reason: string; evidence: unknown }) {
    return this.serializable(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: input.orderId } });
      if (!order) throw new NotFoundError("Order");
      if (order.status === "REFUNDED" || order.status === "DISPUTED") throw new ConflictError("Order cannot be disputed in its current state");
      const dispute = await tx.dispute.create({
        data: { orderId: order.id, reason: input.reason, evidence: input.evidence as Prisma.InputJsonValue, escrowCents: order.totalCents - order.refundedCents },
      });
      await tx.order.update({ where: { id: order.id }, data: { status: "DISPUTED" } });
      await tx.outboxEvent.create({ data: {
        type: "dispute.opened", aggregateId: dispute.id,
        payload: { disputeId: dispute.id, orderId: order.id, escrowCents: dispute.escrowCents },
      } });
      return dispute;
    });
  }
}
