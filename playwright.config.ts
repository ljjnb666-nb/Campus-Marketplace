import { defineConfig, devices } from "@playwright/test";

/**
 * Production Phase 2 — Release Gate E2E
 *
 * 运行前提（npm run e2e:prepare 负责准备 DB，服务容器需已启动）：
 * - PostgreSQL / Redis / MinIO 由 docker compose 或 CI service 提供
 * - 应用以 production build 启动（npm run build && npm run start），
 *   通过 webServer 隔离环境变量指向 E2E 专用数据库 campus_e2e
 *
 * 本地默认 0 retry（暴露 flaky），CI 受控 retry + worker 数。
 */

const isCI = !!process.env.CI;

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/campus_e2e?schema=public&connection_limit=10";

const redisUrl = process.env.E2E_REDIS_URL ?? process.env.REDIS_URL ?? "redis://localhost:6379";

const s3Endpoint =
  process.env.E2E_S3_ENDPOINT ?? process.env.S3_ENDPOINT ?? "http://localhost:9100";

// 与 docker-compose.yml / .env.example 保持一致的本地 MinIO 默认值。
// 凭据用 E2E 专用账号（compose minio-init 引导创建）：生产守卫会在
// production 模式拒绝 minioadmin 默认凭据，E2E 因此也真实覆盖了该安全属性。
const webServerEnv = {
  ...process.env,
  NODE_ENV: "production" as const,
  DATABASE_URL: e2eDatabaseUrl,
  REDIS_URL: redisUrl,
  NEXTAUTH_URL: baseURL,
  NEXTAUTH_SECRET: process.env.E2E_NEXTAUTH_SECRET ?? "e2e-only-nextauth-secret-not-for-prod",
  APP_NAME: process.env.APP_NAME ?? "校园集市",
  DEFAULT_CAMPUS_SLUG: "main-campus",
  S3_ENDPOINT: s3Endpoint,
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_ACCESS_KEY_ID: process.env.E2E_S3_ACCESS_KEY_ID ?? "e2e-local",
  S3_SECRET_ACCESS_KEY: process.env.E2E_S3_SECRET_ACCESS_KEY ?? "E2eLocalSecret2026x",
  S3_BUCKET_PUBLIC: process.env.S3_BUCKET_PUBLIC ?? "campus-public",
  S3_BUCKET_PRIVATE: process.env.S3_BUCKET_PRIVATE ?? "campus-private",
  S3_FORCE_PATH_STYLE: "true",
  PUBLIC_ASSET_BASE_URL:
    process.env.PUBLIC_ASSET_BASE_URL ?? `${s3Endpoint}/campus-public`,
  PRIVATE_SIGNED_URL_TTL_SECONDS: "300",
  STORAGE_QUOTA_MB: "500",
  // E2E 是"production build + 本机 MinIO"的冒烟场景：显式打开 env.ts 的
  // 生产守卫逃生阀（真实生产部署绝不允许设置该变量）
  ALLOW_LOCAL_S3_IN_PRODUCTION: "true",
  // HTTP metrics 黑盒测试（http-metrics.spec.ts）：合法专用 token
  //（>=24 字符，非 NEXTAUTH_SECRET，非危险默认值——与运行时安全契约一致）
  METRICS_BEARER_TOKEN:
    process.env.E2E_METRICS_TOKEN ?? ["e2e-dedicated-metrics-token-", "qwertyuiopasdfgh"].join(""),
};

export default defineConfig({
  testDir: "tests/e2e",

  // 每个 spec 独立创建自己需要的数据（唯一标题/邮箱），禁止跨 spec 依赖
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 2 : undefined,

  reporter: [
    ["list"],
    ["html", { outputFolder: "tests/e2e/.report", open: "never" }],
  ],

  outputDir: "tests/e2e/.artifacts",

  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    locale: "zh-CN",
  },

  projects: [
    // 依赖项目：真实登录生成 storageState（.auth/*.json，已 gitignore）
    {
      name: "setup",
      testMatch: /auth-setup\.ts/,
    },
    {
      name: "chromium",
      testIgnore: /legal-version-upgrade\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
    {
      // Phase 5 GF-L3：发布全局立即生效的新政策版本，必须等主套件全部
      // 结束后单独执行（否则并行 worker 中"注册早于发布"的用户会被
      // 打成 OUTDATED，产生跨测试污染）
      name: "governance-last",
      testMatch: /legal-version-upgrade\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["chromium"],
    },
  ],

  webServer: {
    command: "npm run start",
    url: `${baseURL}/api/health`,
    timeout: 120_000,
    reuseExistingServer: !isCI,
    env: webServerEnv,
    stdout: "ignore",
    stderr: "pipe",
  },
});
