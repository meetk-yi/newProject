import Fastify from "fastify";
import { database } from "./infrastructure/database.js";
import { createCommerceUseCases } from "./application/index.js";
import { DomainError } from "./domain/errors.js";
import { env } from "./config/env.js";
import { registerRoutes } from "./presentation/routes.js";
import { ZodError } from "zod";

export function createApp() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });
  const commerce = createCommerceUseCases(database);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: "VALIDATION_ERROR", message: "Invalid request", details: error.issues },
      });
    }
    request.log.error({ err: error }, "Request failed");
    return reply
      .code(500)
      .send({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
  });

  app.get("/health", async () => ({ status: "ok" }));
  registerRoutes(app, commerce);
  return app;
}
