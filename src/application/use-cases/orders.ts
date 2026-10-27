import { Prisma, PrismaClient } from "@prisma/client";
import { OrderAggregate } from "../../domain/order.js";
import { Money } from "../../domain/money.js";
import { calculateDiscount, calculateTax, assertPositiveInteger } from "../../domain/policies.js";
import {
  ConflictError,
  DomainError,
  InsufficientFundsError,
  NotFoundError,
} from "../../domain/errors.js";
import { inSerializableTransaction } from "../shared/transaction.js";

export type CheckoutInput = {
  userId: string;
  items: Array<{ productId: string; quantity: number; warehouse?: string | undefined }>;
  discountCodes?: string[] | undefined;
  payment: { method: "wallet" | "card"; walletId?: string | undefined };
};

export class OrderUseCases {
  constructor(private readonly database: PrismaClient) {}

  async checkout(input: CheckoutInput) {
    if (input.payment.method === "card") {
      throw new DomainError(
        "Card payment provider is not configured",
        "PAYMENT_PROVIDER_UNAVAILABLE",
        503,
      );
    }

    return inSerializableTransaction(this.database, async (transaction) => {
      const user = await transaction.user.findUnique({ where: { id: input.userId } });
      if (!user) throw new NotFoundError("User");

      const requestedItems = this.aggregateItems(input.items);
      const productIds = [...new Set(requestedItems.map((item) => item.productId))];
      const products = await transaction.product.findMany({
        where: { id: { in: productIds }, active: true },
      });
      if (products.length !== productIds.length) throw new NotFoundError("Product");
      const productsById = new Map(products.map((product) => [product.id, product]));
      const subtotalCents = await this.reserveStock(transaction, requestedItems, productsById);
      const discountCents = await this.applyDiscounts(
        transaction,
        user.tier,
        input.discountCodes ?? [],
        subtotalCents,
      );
      const taxCents = calculateTax(subtotalCents - discountCents);
      const aggregate = OrderAggregate.place({
        userId: input.userId,
        subtotal: Money.of(subtotalCents),
        discount: Money.of(discountCents),
        tax: Money.of(taxCents),
      });
      const order = await transaction.order.create({
        data: {
          id: aggregate.id,
          userId: input.userId,
          subtotalCents,
          discountCents,
          taxCents,
          totalCents: aggregate.total.cents,
          lines: {
            create: requestedItems.map((item) => ({
              ...item,
              unitPriceCents: productsById.get(item.productId)!.priceCents,
            })),
          },
        },
        include: { lines: true },
      });

      await transaction.outboxEvent.createMany({
        data: aggregate.pullEvents().map((event) => ({
          type: event.type,
          aggregateId: event.aggregateId,
          payload: event.payload,
        })),
      });
      await this.chargeWallet(transaction, input, order.id, order.totalCents);
      return order;
    });
  }

  async refund(orderId: string, amountCents: number, reason: string) {
    return inSerializableTransaction(this.database, async (transaction) => {
      const order = await transaction.order.findUnique({
        where: { id: orderId },
        include: { lines: true },
      });
      if (!order) throw new NotFoundError("Order");
      if (order.status === "DISPUTED") {
        throw new ConflictError("A disputed order cannot be refunded");
      }

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
      const refundedCents = aggregate.refunded.cents;

      const updated = await transaction.order.updateMany({
        where: { id: orderId, refundedCents: order.refundedCents },
        data: {
          refundedCents,
          status: aggregate.state,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictError("Order refund changed concurrently; retry the request");
      }

      await transaction.refund.create({ data: { orderId, amountCents, reason } });
      await transaction.outboxEvent.createMany({
        data: aggregate.pullEvents().map((event) => ({
          type: event.type,
          aggregateId: event.aggregateId,
          payload: event.payload,
        })),
      });
      await this.reverseWalletPayment(transaction, orderId, amountCents);
      if (aggregate.state === "REFUNDED") {
        await Promise.all(
          order.lines.map((line) =>
            transaction.inventory.update({
              where: {
                productId_warehouse: {
                  productId: line.productId,
                  warehouse: line.warehouse,
                },
              },
              data: { onHand: { increment: line.quantity } },
            }),
          ),
        );
      }
      return { orderId, refundedCents, status: aggregate.state };
    });
  }

  private aggregateItems(items: CheckoutInput["items"]) {
    const requested = new Map<string, { productId: string; warehouse: string; quantity: number }>();
    for (const item of items) {
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
    return [...requested.values()];
  }

  private async reserveStock(
    transaction: Prisma.TransactionClient,
    items: ReturnType<OrderUseCases["aggregateItems"]>,
    productsById: Map<string, { sku: string; priceCents: number }>,
  ): Promise<number> {
    let subtotalCents = 0;
    for (const item of items) {
      const product = productsById.get(item.productId)!;
      const updated = await transaction.$executeRaw`
        UPDATE "Inventory"
        SET "onHand" = "onHand" - ${item.quantity}
        WHERE "productId" = ${item.productId}::uuid
          AND "warehouse" = ${item.warehouse}
          AND "onHand" - "reserved" >= ${item.quantity}
      `;
      if (updated !== 1) {
        throw new ConflictError(`Insufficient stock for ${product.sku} in ${item.warehouse}`);
      }
      subtotalCents += product.priceCents * item.quantity;
    }
    return subtotalCents;
  }

  private async applyDiscounts(
    transaction: Prisma.TransactionClient,
    userTier: string,
    codes: string[],
    subtotalCents: number,
  ): Promise<number> {
    let discountCents = 0;
    for (const [index, code] of codes.entries()) {
      const discount = await transaction.discount.findUnique({ where: { code } });
      if (
        !discount ||
        !discount.active ||
        (discount.expiresAt && discount.expiresAt <= new Date()) ||
        (discount.maxUses !== null && discount.uses >= discount.maxUses) ||
        (discount.allowedTiers.length > 0 && !discount.allowedTiers.includes(userTier))
      ) {
        throw new ConflictError(`Discount ${code} is not valid`);
      }
      if (
        index > 0 &&
        (!discount.stackable ||
          !(await transaction.discount.findUniqueOrThrow({ where: { code: codes[index - 1]! } }))
            .stackable)
      ) {
        throw new ConflictError("Discounts cannot be combined");
      }

      discountCents += calculateDiscount(subtotalCents, discount.percentOff, discount.minimumCents);
      const usage = await transaction.discount.updateMany({
        where: {
          id: discount.id,
          active: true,
          ...(discount.maxUses === null ? {} : { uses: { lt: discount.maxUses } }),
        },
        data: { uses: { increment: 1 } },
      });
      if (usage.count !== 1) {
        throw new ConflictError(`Discount ${code} usage limit was reached`);
      }
    }
    return Math.min(discountCents, subtotalCents);
  }

  private async chargeWallet(
    transaction: Prisma.TransactionClient,
    input: CheckoutInput,
    orderId: string,
    amountCents: number,
  ): Promise<void> {
    if (input.payment.method !== "wallet" || !input.payment.walletId) {
      throw new ConflictError("A wallet payment method and wallet ID are required");
    }
    const wallet = await transaction.wallet.findUnique({
      where: { id: input.payment.walletId },
    });
    if (!wallet) throw new NotFoundError("Wallet");
    if (wallet.userId !== input.userId) {
      throw new ConflictError("Payment wallet does not belong to the ordering user");
    }
    const debited = await transaction.$executeRaw`
      UPDATE "Wallet"
      SET "balanceCents" = "balanceCents" - ${amountCents}
      WHERE id = ${wallet.id}::uuid
        AND "balanceCents" >= ${amountCents}
    `;
    if (debited !== 1) throw new InsufficientFundsError();
    await transaction.ledgerEntry.create({
      data: {
        walletId: wallet.id,
        amountCents: -amountCents,
        currency: wallet.currency,
        kind: "ORDER_PAYMENT",
        reference: orderId,
      },
    });
  }

  private async reverseWalletPayment(
    transaction: Prisma.TransactionClient,
    orderId: string,
    amountCents: number,
  ): Promise<void> {
    const payment = await transaction.ledgerEntry.findFirst({
      where: { reference: orderId, kind: "ORDER_PAYMENT" },
    });
    if (!payment) return;
    const wallet = await transaction.wallet.findUniqueOrThrow({
      where: { id: payment.walletId },
    });
    await transaction.wallet.update({
      where: { id: wallet.id },
      data: { balanceCents: { increment: amountCents } },
    });
    await transaction.ledgerEntry.create({
      data: {
        walletId: wallet.id,
        amountCents,
        currency: wallet.currency,
        kind: "ORDER_REFUND",
        reference: orderId,
      },
    });
  }
}
