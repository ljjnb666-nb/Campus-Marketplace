import { PrismaClient, type Prisma } from "@prisma/client";

const isDev = process.env.NODE_ENV === "development";

// 为 DATABASE_URL 注入连接池参数（Prisma 通过 URL 查询参数控制连接池行为）
// 仅在 URL 中未显式配置时追加默认值
function buildDatasourceUrl(): string {
  const baseUrl = process.env.DATABASE_URL ?? "";
  const params: string[] = [];
  if (!baseUrl.includes("connection_limit")) params.push("connection_limit=10");
  if (!baseUrl.includes("pool_timeout")) params.push("pool_timeout=10");
  if (params.length === 0) return baseUrl;
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}${params.join("&")}`;
}

declare global {
  var prisma: PrismaClient | undefined;
}

export const prisma =
  global.prisma ??
  new PrismaClient({
    log: isDev ? ["error", "warn", "query"] : ["error"],
    datasourceUrl: buildDatasourceUrl(),
  });

if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}

// 交互事务的默认超时时间（毫秒），防止慢查询阻塞连接池
const TRANSACTION_TIMEOUT_MS = 10_000;

/**
 * 带默认超时的交互事务封装。
 * 所有业务代码应优先使用此函数而非直接调用 prisma.$transaction(async (tx) => ...)。
 * 批量事务 prisma.$transaction([tx1, tx2]) 不需要超时保护。
 */
export async function withTransaction<T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeout?: number },
): Promise<T> {
  return prisma.$transaction(callback, {
    timeout: options?.timeout ?? TRANSACTION_TIMEOUT_MS,
  });
}

// 生产环境启动时验证数据库连通性
if (process.env.NODE_ENV === "production") {
  prisma
    .$connect()
    .then(() => {
      console.log("[prisma] 数据库连接成功");
    })
    .catch((e) => {
      console.error("[prisma] 启动连接失败:", e.message);
      process.exit(1);
    });
}
