import { PrismaClient } from "@prisma/client";
import { ConflictError } from "../../domain/errors.js";
import { assertPositiveInteger } from "../../domain/policies.js";
import { inSerializableTransaction } from "../shared/transaction.js";

export class InventoryUseCases {
  constructor(private readonly database: PrismaClient) {}

  async allocate(productId: string, warehouse: string, quantity: number, ttlSeconds: number) {
    assertPositiveInteger(quantity, "quantity");
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    return inSerializableTransaction(this.database, async (transaction) => {
      const expiredAllocations = await transaction.allocation.findMany({
        where: { productId, warehouse, releasedAt: null, expiresAt: { lte: new Date() } },
      });
      for (const allocation of expiredAllocations) {
        const released = await transaction.allocation.updateMany({
          where: { id: allocation.id, releasedAt: null },
          data: { releasedAt: new Date() },
        });
        if (released.count === 1) {
          await transaction.inventory.update({
            where: { productId_warehouse: { productId, warehouse } },
            data: { reserved: { decrement: allocation.quantity } },
          });
        }
      }

      const allocated = await transaction.$executeRaw`
        UPDATE "Inventory"
        SET "reserved" = "reserved" + ${quantity}
        WHERE "productId" = ${productId}::uuid
          AND "warehouse" = ${warehouse}
          AND "onHand" - "reserved" >= ${quantity}
      `;
      if (allocated !== 1) throw new ConflictError("Insufficient available inventory");
      return transaction.allocation.create({
        data: { productId, warehouse, quantity, expiresAt },
      });
    });
  }
}
