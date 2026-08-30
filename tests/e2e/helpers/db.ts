/**
 * Playwright 侧的最终状态断言（Browser drives action, DB verifies invariant）。
 * 连接 E2E 专用数据库，与被测应用同库——这是断言，不是 mock。
 */
import { PrismaClient } from "@prisma/client";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/campus_e2e?schema=public";

let client: PrismaClient | undefined;

export function e2eDb(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      datasources: { db: { url: E2E_DATABASE_URL } },
    });
  }
  return client;
}
