import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

export const database = new PrismaClient({
  log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});
