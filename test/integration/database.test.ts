import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL;
const client = databaseUrl
  ? new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  : undefined;

describe.skipIf(!client)("PostgreSQL integration", () => {
  afterAll(async () => {
    await client?.$disconnect();
  });

  it("connects to the configured test database", async () => {
    const result = await client!.$queryRaw<Array<{ value: number }>>`SELECT 1::int AS value`;
    expect(result).toEqual([{ value: 1 }]);
  });
});
