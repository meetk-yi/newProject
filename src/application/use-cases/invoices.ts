import { PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../domain/errors.js";

export class InvoiceUseCases {
  constructor(private readonly database: PrismaClient) {}

  async generate(orderId: string) {
    return this.database.$transaction(async (transaction) => {
      const order = await transaction.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundError("Order");

      const invoice = await transaction.invoice.upsert({
        where: { orderId },
        create: { orderId },
        update: { status: "PENDING" },
      });
      await transaction.outboxEvent.create({
        data: {
          type: "invoice.generation.requested",
          aggregateId: invoice.id,
          payload: {
            invoiceId: invoice.id,
            orderId: order.id,
            totalCents: order.totalCents,
            currency: order.currency,
          },
        },
      });
      return { invoiceId: invoice.id, status: invoice.status };
    });
  }
}
