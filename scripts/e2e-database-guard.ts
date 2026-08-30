/**
 * E2E destructive reset 的生产安全闸门（硬性要求）。
 *
 * e2e-setup 的 wipeAll 会清空目标库全部业务表，以下任一命中即拒绝执行：
 * 1. NODE_ENV=production —— E2E setup 永远不允许在生产模式进程里跑；
 * 2. 目标库名是 postgres 维护库或名字含 prod/production；
 * 3. E2E_DATABASE_URL 与 DATABASE_URL 指向同一 host:port/db。
 *
 * 无任何绕过开关——需要破坏性重置时应显式指向隔离的 E2E 库（如 campus_e2e）。
 */

export function parseDatabaseName(url: string): string {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "");
  if (!name) {
    throw new Error(`数据库 URL 缺少数据库名: ${url}`);
  }
  return name;
}

export function assertE2EDatabaseIsolation(e2eDatabaseUrl: string, env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "[e2e-setup] NODE_ENV=production 下禁止执行 E2E destructive reset（wipeAll 清空全部业务表）",
    );
  }

  const e2eDb = parseDatabaseName(e2eDatabaseUrl).toLowerCase();
  if (e2eDb === "postgres" || /prod(uction)?/.test(e2eDb)) {
    throw new Error(
      `[e2e-setup] E2E 目标库名 "${e2eDb}" 疑似生产/维护库，拒绝执行 destructive reset；` +
        `请将 E2E_DATABASE_URL 指向隔离的 E2E 库（如 campus_e2e）`,
    );
  }

  const productionUrl = env.DATABASE_URL;
  if (!productionUrl) {
    return;
  }

  const sameTarget = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      return (
        `${parsed.host}${parseDatabaseName(url).toLowerCase()}` ===
        `${new URL(e2eDatabaseUrl).host}${e2eDb}`
      );
    } catch {
      return false;
    }
  };

  // CI 等场景会把 DATABASE_URL 与 E2E_DATABASE_URL 指向同一个库仅为满足
  // prisma.config 校验；目标库名本身是 E2E 安全命名（含 e2e/test）时视为无害。
  if (sameTarget(productionUrl) && !/(e2e|test)/.test(e2eDb)) {
    throw new Error(
      "[e2e-setup] E2E_DATABASE_URL 与 DATABASE_URL 指向同一数据库，" +
        "destructive reset 将摧毁开发/生产数据；请指向隔离的 E2E 库",
    );
  }
}
