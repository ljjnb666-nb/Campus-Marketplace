import { defineConfig, devices } from "@playwright/test";

/**
 * PHASE 7H FINAL REPAIR 2 — DUPLICATE DOM DIAGNOSTIC HARNESS（独立于正式 config）。
 *
 * 仅用于根因诊断（§4-§12 stress matrix / D1-D2 / RAW-vs-DOM 证据采集）。
 * 正式 playwright.config.ts 零改动；本 config 不进入 release gate。
 * webServer 环境与正式 config 逐字段镜像（E2E 专用库 / MinIO / token）。
 */

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/campus_e2e?schema=public&connection_limit=10";

const redisUrl = process.env.E2E_REDIS_URL ?? process.env.REDIS_URL ?? "redis://localhost:6379";

const s3Endpoint =
  process.env.E2E_S3_ENDPOINT ?? process.env.S3_ENDPOINT ?? "http://localhost:9100";

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
  ALLOW_LOCAL_S3_IN_PRODUCTION: "true",
  METRICS_BEARER_TOKEN:
    process.env.E2E_METRICS_TOKEN ?? ["e2e-dedicated-metrics-token-", "qwertyuiopasdfgh"].join(""),
};

export default defineConfig({
  testDir: "tests/diagnostics",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  outputDir: "tests/diagnostics/.artifacts",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    locale: "zh-CN",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run start",
    url: `${baseURL}/api/health`,
    timeout: 120_000,
    reuseExistingServer: true,
    env: webServerEnv,
    stdout: "ignore",
    stderr: "pipe",
  },
});
