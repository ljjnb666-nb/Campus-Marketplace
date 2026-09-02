/**
 * 生产环境变量校验（部署 preflight）。
 *
 * 用法：npx tsx scripts/production-env-check.ts [--file .env.production]
 *
 * 只验证：变量存在、格式合理、生产危险默认值不存在。
 * 绝不输出任何秘密值——所有报告只打印变量名与 PASS/FAIL。
 */
import { readFileSync } from "node:fs";

const UNSAFE_DEFAULTS = [
  "minioadmin",
  "postgres:postgres",
  "dummy-secret-for-ci-tests-only",
  "e2e-only-nextauth-secret-not-for-prod",
  "E2eLocalSecret2026x",
  "E2eLocal",
  "changeme",
  "password",
  "123456",
];

type CheckResult = { name: string; ok: boolean; message?: string };

function loadEnvFile(file: string): Record<string, string> {
  try {
    const raw = readFileSync(file, "utf8");
    const vars: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      vars[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    console.error(`无法读取 ${file}：请先 cp .env.production.example .env.production 并填写`);
    process.exit(1);
  }
}

function containsUnsafeDefault(value: string): string | undefined {
  const lowered = value.toLowerCase();
  return UNSAFE_DEFAULTS.find((d) => lowered.includes(d.toLowerCase()));
}

function check(
  results: CheckResult[],
  name: string,
  ok: boolean,
  message?: string,
): void {
  results.push({ name, ok, message });
}

export type EnvCheckResult = CheckResult;

/**
 * 环境契约检查（纯函数，供 CLI 与 ops-check 复用）。
 * 只验证变量存在、格式合理、危险默认值不存在；绝不返回/输出秘密值。
 */
export function collectEnvChecks(vars: Record<string, string | undefined>): EnvCheckResult[] {
  const results: EnvCheckResult[] = [];

  // ---- 数据库 ----
  const databaseUrl = vars.DATABASE_URL ?? "";
  try {
    const db = new URL(databaseUrl);
    const dbHost = db.hostname;
    check(
      results,
      "DATABASE_URL",
      db.protocol === "postgresql:" || db.protocol === "postgres:",
      "必须是 postgresql:// 连接串",
    );
    check(results, "DATABASE_URL.host", dbHost !== "" , "缺少主机");
    check(
      results,
      "DATABASE_URL.localhost",
      dbHost !== "localhost" && dbHost !== "127.0.0.1",
      "生产数据库不允许指向 localhost（容器网络内应使用服务名）",
    );
    check(
      results,
      "DATABASE_URL.password",
      db.password.length >= 16 && containsUnsafeDefault(db.password) === undefined,
      "数据库密码缺失/过短/含危险默认值",
    );
  } catch {
    check(results, "DATABASE_URL", false, "不是合法 URL");
  }

  // ---- Redis ----
  const redisUrl = vars.REDIS_URL ?? "";
  try {
    const redis = new URL(redisUrl);
    check(results, "REDIS_URL", redis.protocol === "redis:" || redis.protocol === "rediss:", "必须是 redis:// 连接串");
    check(
      results,
      "REDIS_URL.password",
      redis.password.length >= 16 && containsUnsafeDefault(redis.password) === undefined,
      "Redis 密码缺失/过短/含危险默认值",
    );
  } catch {
    check(results, "REDIS_URL", false, "不是合法 URL");
  }

  // ---- Auth.js ----
  const nextauthUrl = vars.NEXTAUTH_URL ?? "";
  check(
    results,
    "NEXTAUTH_URL",
    nextauthUrl.startsWith("https://"),
    "生产 origin 必须是 https://",
  );
  const nextauthSecret = vars.NEXTAUTH_SECRET ?? "";
  check(
    results,
    "NEXTAUTH_SECRET",
    nextauthSecret.length >= 32 && containsUnsafeDefault(nextauthSecret) === undefined,
    "NEXTAUTH_SECRET 缺失/短于 32 字符/含 CI dummy 值",
  );

  // ---- 对象存储 ----
  const s3Endpoint = vars.S3_ENDPOINT ?? "";
  const allowLocalS3 = vars.ALLOW_LOCAL_S3_IN_PRODUCTION === "true";
  check(results, "S3_ENDPOINT", s3Endpoint !== "", "必须设置");
  if (s3Endpoint) {
    try {
      const endpoint = new URL(s3Endpoint);
      const local = ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname);
      check(
        results,
        "S3_ENDPOINT.local",
        !local || allowLocalS3,
        "指向 localhost（自建 MinIO 在容器网络内应使用 http://minio:9000）",
      );
      check(
        results,
        "S3_ENDPOINT.https",
        endpoint.protocol === "https:" || (local && allowLocalS3) || endpoint.hostname === "minio",
        "生产外部对象存储必须 https",
      );
    } catch {
      check(results, "S3_ENDPOINT", false, "不是合法 URL");
    }
  }
  check(
    results,
    "S3_ACCESS_KEY_ID",
    (vars.S3_ACCESS_KEY_ID ?? "").length >= 8 &&
      containsUnsafeDefault(vars.S3_ACCESS_KEY_ID ?? "") === undefined,
    "缺失或使用 minioadmin",
  );
  check(
    results,
    "S3_SECRET_ACCESS_KEY",
    (vars.S3_SECRET_ACCESS_KEY ?? "").length >= 16 &&
      containsUnsafeDefault(vars.S3_SECRET_ACCESS_KEY ?? "") === undefined,
    "缺失或使用 minioadmin",
  );
  check(results, "S3_BUCKET_PUBLIC", (vars.S3_BUCKET_PUBLIC ?? "") !== "", "必须设置");
  check(results, "S3_BUCKET_PRIVATE", (vars.S3_BUCKET_PRIVATE ?? "") !== "", "必须设置");

  // ---- self-hosted MinIO 固定 bucket 契约 ----
  // compose 的 Caddy /assets/* 只读出口硬编码转发到 campus-public（deploy/Caddyfile），
  // minio-init 也按该名字建桶；端点指向容器内 minio 服务时必须与之一致，
  // 否则出现"app 写入 A 桶 / Caddy 读 B 桶"的静默配置漂移。
  let selfHostedMinio = false;
  if (s3Endpoint) {
    try {
      selfHostedMinio = new URL(s3Endpoint).hostname === "minio";
    } catch {
      selfHostedMinio = false;
    }
  }
  check(
    results,
    "S3_BUCKET_PUBLIC.selfhosted-contract",
    !selfHostedMinio || vars.S3_BUCKET_PUBLIC === "campus-public",
    "self-hosted MinIO 固定使用 campus-public（Caddy /assets 出口与 minio-init 的硬契约）",
  );
  check(
    results,
    "S3_BUCKET_PRIVATE.selfhosted-contract",
    !selfHostedMinio || vars.S3_BUCKET_PRIVATE === "campus-private",
    "self-hosted MinIO 固定使用 campus-private（minio-init/policy 硬契约）",
  );
  check(
    results,
    "PUBLIC_ASSET_BASE_URL",
    (vars.PUBLIC_ASSET_BASE_URL ?? "").startsWith("http"),
    "必须设置（公开对象的基础 URL）",
  );

  // ---- 应用元信息 ----
  check(results, "SITE_ADDRESS", (vars.SITE_ADDRESS ?? "") !== "", "必须设置（Caddy 站点地址）");
  check(results, "APP_NAME", (vars.APP_NAME ?? "") !== "", "必须设置");
  check(results, "DEFAULT_CAMPUS_SLUG", (vars.DEFAULT_CAMPUS_SLUG ?? "") !== "", "必须设置");

  // ---- 安全开关 ----
  check(
    results,
    "ALLOW_LOCAL_S3_IN_PRODUCTION",
    !allowLocalS3,
    "生产服务器上禁止开启（仅限本机冒烟验证）",
  );

  // ---- 备份 ----
  check(results, "BACKUP_DIR", (vars.BACKUP_DIR ?? "") !== "", "必须设置（备份目录）");

  return results;
}

function main(): void {
  const fileArg = process.argv.indexOf("--file");
  const file = fileArg !== -1 ? process.argv[fileArg + 1] : ".env.production";
  const vars = { ...loadEnvFile(file), ...process.env };

  const results = collectEnvChecks(vars);

  // ---- 汇总（只打印变量名，不打印值）----
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    const status = r.ok ? "PASS" : "FAIL";
    const detail = !r.ok && r.message ? ` — ${r.message}` : "";
    console.log(`${status.padEnd(4)} ${r.name}${detail}`);
  }

  if (failed.length > 0) {
    console.error(`\nproduction-env-check: ${failed.length} 项不合规，拒绝部署`);
    process.exit(1);
  }
  console.log(`\nproduction-env-check: 全部 ${results.length} 项通过（未输出任何秘密值）`);
}

if (process.argv[1] && process.argv[1].endsWith("production-env-check.ts")) {
  main();
}
