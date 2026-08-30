/**
 * E2E destructive reset 的生产安全闸门（硬性要求）。
 *
 * e2e-setup 的 wipeAll 会清空目标库全部业务表。放行条件为显式 allow policy，
 * 全部满足才允许执行：
 *
 *   NODE_ENV !== "production"                          （任何 override 都不能绕过）
 *   AND 数据库名明确为 E2E 命名                          （e2e 作为独立语义段，
 *       如 campus_e2e / e2e / xxx-e2e-yyy；含 prod/production 或 postgres
 *       维护库名一律拒绝；"e2etest" 这类粘连不视为 E2E 命名）
 *   AND ( host 为 loopback（localhost/127.0.0.1/::1——本地与 CI service
 *         端口映射均为 loopback）
 *         OR E2E_DESTRUCTIVE_RESET_ALLOWED=1（显式 override，仅供 E2E 专用
 *         环境；NODE_ENV=production 下无效） )
 *   AND 若与 DATABASE_URL 同库：同样必须满足上述 E2E-safe 条件
 *       （CI 把两个变量指向同一 localhost E2E 库仅为满足 prisma.config 校验）
 *
 * 另：URL 无法解析（缺数据库名/非法 URL）直接拒绝。
 * 日志只允许输出 sanitized URL（隐藏用户名/密码/query），见 sanitizeDatabaseUrl。
 */

/** 输出日志用的 sanitized URL：scheme://***:***@host[:port]/dbname（无用户名/密码/query） */
export function sanitizeDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const auth = `***:***@`;
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${parsed.protocol}//${auth}${parsed.hostname}${port}${parsed.pathname}`;
  } catch {
    return "<unparseable-url>";
  }
}

/** 数据库名是否明确为 E2E 命名（e2e 作为独立语义段） */
export function isExplicitE2EDatabaseName(name: string): boolean {
  const lowered = name.toLowerCase();
  if (lowered === "e2e") {
    return true;
  }
  return /(^|[-_.])e2e([-_.]|$)/.test(lowered);
}

export function parseDatabaseName(url: string): string {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "");
  if (!name) {
    throw new Error(`数据库 URL 缺少数据库名: ${sanitizeDatabaseUrl(url)}`);
  }
  return name;
}

function isLoopbackHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** 该目标库是否满足"明确 E2E 安全环境"（不含 NODE_ENV 判断） */
function isE2ESafeTarget(e2eDatabaseUrl: string, env: NodeJS.ProcessEnv): boolean {
  const explicitOverride = env.E2E_DESTRUCTIVE_RESET_ALLOWED === "1";

  if (!isLoopbackHost(e2eDatabaseUrl) && !explicitOverride) {
    return false;
  }

  // 名单硬拒：postgres 维护库 / 一切 prod 命名（即使带 e2e 语义段）
  const dbName = parseDatabaseName(e2eDatabaseUrl).toLowerCase();
  if (dbName === "postgres" || /prod(uction)?/.test(dbName)) {
    return false;
  }

  return isExplicitE2EDatabaseName(dbName);
}

export function assertE2EDatabaseIsolation(e2eDatabaseUrl: string, env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "[e2e-setup] NODE_ENV=production 下禁止执行 E2E destructive reset（wipeAll 清空全部业务表）；无任何 override",
    );
  }

  let e2eDb: string;
  try {
    e2eDb = parseDatabaseName(e2eDatabaseUrl).toLowerCase();
  } catch (error) {
    throw new Error(`[e2e-setup] E2E_DATABASE_URL 无法解析：${error instanceof Error ? error.message : error}`);
  }

  if (!isE2ESafeTarget(e2eDatabaseUrl, env)) {
    throw new Error(
      `[e2e-setup] 目标库 "${e2eDb}" 不满足 E2E destructive reset allow policy ` +
        `（要求：明确 E2E 命名 + loopback host 或 E2E_DESTRUCTIVE_RESET_ALLOWED=1）；` +
        `请将 E2E_DATABASE_URL 指向隔离的 E2E 库（如 campus_e2e @ localhost）`,
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

  // 与 DATABASE_URL 同库：仅当目标本身满足完整 E2E-safe 条件（isE2ESafeTarget
  // 已在上方通过）才放行——CI 满足 prisma.config 校验的场景即此形态。
  if (sameTarget(productionUrl) && !isE2ESafeTarget(productionUrl, env)) {
    throw new Error(
      "[e2e-setup] E2E_DATABASE_URL 与 DATABASE_URL 指向同一数据库，" +
        "destructive reset 将摧毁开发/生产数据；请指向隔离的 E2E 库",
    );
  }
}
