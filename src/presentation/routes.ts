import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CommerceService } from "../application/commerce-service.js";

const uuid = z.string().uuid();
const positiveInt = z.number().int().positive();
const checkoutSchema = z.object({
  userId: uuid,
  items: z.array(z.object({
    productId: uuid, quantity: positiveInt, warehouse: z.string().min(1).optional(),
  })).min(1),
  discountCodes: z.array(z.string().min(1)).optional(),
  payment: z.discriminatedUnion("method", [
    z.object({ method: z.literal("wallet"), walletId: uuid }),
    z.object({ method: z.literal("card") }),
  ]),
});

export function registerRoutes(app: FastifyInstance, commerce: CommerceService): void {
  app.post("/api/v1/orders/checkout", async (request, reply) => {
    const input = checkoutSchema.parse(request.body);
    return reply.code(201).send(await commerce.checkout(input));
  });
  app.post("/api/v1/orders/:id/refund", async (request, reply) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ amountCents: positiveInt, reason: z.string().min(3).max(500) }).parse(request.body);
    return commerce.refund(params.id, body.amountCents, body.reason);
  });
  app.post("/api/v1/inventory/allocate", async (request, reply) => {
    const body = z.object({
      productId: uuid, warehouse: z.string().min(1), quantity: positiveInt,
      ttlSeconds: z.number().int().min(1).max(86_400).default(900),
    }).parse(request.body);
    return reply.code(201).send(await commerce.allocate(body.productId, body.warehouse, body.quantity, body.ttlSeconds));
  });
  app.post("/api/v1/discounts/validate", async (request) => {
    const body = z.object({ userId: uuid, subtotalCents: z.number().int().nonnegative(), codes: z.array(z.string().min(1)).min(1) }).parse(request.body);
    return commerce.validateDiscount(body);
  });
  app.post("/api/v1/loyalty/redeem", async (request) => {
    const body = z.object({ userId: uuid, points: positiveInt }).parse(request.body);
    return commerce.redeemLoyalty(body.userId, body.points);
  });
  app.post("/api/v1/wallet/transfer", async (request) => {
    const body = z.object({
      fromWalletId: uuid, toWalletId: uuid, amountCents: positiveInt,
      idempotencyKey: z.string().min(8).max(128),
    }).parse(request.body);
    return commerce.transfer(body);
  });
  app.get("/api/v1/invoices/:id/generate", async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    return reply.code(202).send(await commerce.generateInvoice(id));
  });
  app.post("/api/v1/subscriptions/renew", async (request) => {
    const { subscriptionId } = z.object({ subscriptionId: uuid }).parse(request.body);
    return commerce.renewSubscription(subscriptionId);
  });
  app.post("/api/v1/shipping/calculate", async (request) => {
    const body = z.object({
      items: z.array(z.object({ productId: uuid, quantity: positiveInt })).min(1),
    }).parse(request.body);
    return commerce.calculateShipping(body);
  });
  app.post("/api/v1/disputes/open", async (request, reply) => {
    const body = z.object({
      orderId: uuid, reason: z.string().min(3).max(500),
      evidence: z.array(z.string().url()).min(1).max(10),
    }).parse(request.body);
    return reply.code(201).send(await commerce.openDispute(body));
  });
}
