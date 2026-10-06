import type { PrismaClient } from "@prisma/client";

/**
 * fail-closed 软删除边界（PRISMA-SOFT-DELETE-IMPL-01）下的测试物理清理 seam。
 *
 * 业务扩展客户端（@/lib/prisma）对软删除模型的 delete/deleteMany 一律拒绝
 * （SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED，物理清理不属于其合同），
 * 测试基建的 fixture User 清理统一经裸 PrismaClient 执行真实硬删除——
 * 与 e2e-setup / rawClient 清理同属"裸客户端清理"语义域，不属于业务客户端。
 */
export async function purgeUserFixture(
  integrationDatabaseUrl: string,
  userId: string,
): Promise<void> {
  const { PrismaClient } = await import("@prisma/client");
  const raw: PrismaClient = new PrismaClient({
    datasources: { db: { url: integrationDatabaseUrl } },
    log: ["error"],
  });

  try {
    await raw.user.deleteMany({ where: { id: userId } });
  } finally {
    await raw.$disconnect();
  }
}
