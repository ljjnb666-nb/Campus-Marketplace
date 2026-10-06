import type { PrismaClient } from "@prisma/client";

/**
 * fail-closed 软删除边界（PRISMA-SOFT-DELETE-IMPL-01 R1）下的 app fixture 物理清理 seam。
 *
 * database identity 绑定规则：fixture 经哪个客户端创建，清理就绑定该客户端的
 * datasource authority。本 seam 只服务于经 @/lib/prisma 创建的 fixture——其
 * authority 是 process.env.DATABASE_URL（buildDatasourceUrl 语义），因此这里
 * 直接读取 DATABASE_URL 并 fail fast，调用方无法误传 INTEGRATION_DATABASE_URL
 * 造成 CREATE_DB != CLEANUP_DB 的跨库漂移（R1 BLOCKER 修复）。
 *
 * 裸 PrismaClient = 未挂软删除扩展：业务扩展客户端对软模型 delete/deleteMany
 * 一律 fail closed（物理清理不属于其合同），测试 fixture 清理经此裸客户端执行
 * 真实硬删除。
 */
export async function purgeUserFixtureFromAppDatabase(userId: string): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "purgeUserFixtureFromAppDatabase: process.env.DATABASE_URL 未设置——" +
        "app fixture 清理必须绑定创建该 fixture 的 app datasource authority（DATABASE_URL），" +
        "禁止漂移到其他 database identity",
    );
  }

  const { PrismaClient } = await import("@prisma/client");
  const raw: PrismaClient = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: ["error"],
  });

  try {
    await raw.user.deleteMany({ where: { id: userId } });
  } finally {
    await raw.$disconnect();
  }
}
