import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { database } from "./infrastructure/database.js";

const app = createApp();

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error({ err: error }, "Failed to start server");
  await database.$disconnect();
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await database.$disconnect();
  });
}
