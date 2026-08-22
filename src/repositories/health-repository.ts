import { prisma } from "@/lib/prisma";

/**
 * 数据库探活：健康检查属于基础设施探测而非业务数据访问，
 * 单独放在仓储层，供 /api/health 路由调用以符合分层规则。
 */
export async function pingDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
