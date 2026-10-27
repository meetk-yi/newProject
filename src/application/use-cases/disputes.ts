import { Prisma, PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError } from "../../domain/errors.js";
import { inSerializableTransaction } from "../shared/transaction.js";

export class DisputeUseCases {
  constructor(private readonly database: PrismaClient) {}

  async open(input: { orderId: string; reason: string; evidence: string[] }) {
    return inSerializableTransaction(this.database, async (transaction) => {
      const order = await transaction.order.findUnique({ where: { id: input.orderId } });
      if (!order) throw new NotFoundError("Order");
      if (order.status === "REFUNDED" || order.status === "DISPUTED") {
        throw new ConflictError("Order cannot be disputed in its current state");
      }

      const escrowCents = order.totalCents - order.refundedCents;
      const dispute = await transaction.dispute.create({
        data: {
          orderId: order.id,
          reason: input.reason,
          evidence: input.evidence as Prisma.InputJsonValue,
          escrowCents,
        },
      });
      const orderUpdated = await transaction.order.updateMany({
        where: { id: order.id, status: order.status },
        data: { status: "DISPUTED" },
      });
      if (orderUpdated.count !== 1) {
        throw new ConflictError("Order dispute changed concurrently; retry the request");
      }
      await transaction.outboxEvent.create({
        data: {
          type: "dispute.opened",
          aggregateId: dispute.id,
          payload: { disputeId: dispute.id, orderId: order.id, escrowCents },
        },
      });
      return dispute;
    });
  }
}
