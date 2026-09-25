import { describe, expect, it, vi } from "vitest";

/**
 * RB-06（§25/§56）：真实依赖 readiness smoke（CI MinIO）。
 *
 * - 正常：Postgres SELECT 1 / Redis（未配置即本地限流模式视为 ok）/
 *   MinIO public bucket / MinIO private bucket 全部可达 → ready。
 * - critical dependency failure：隔离 fixture bucket 名（真实不存在，
 *   不触碰共享 CI bucket）→ storage=failed → not_ready。
 *
 * 仅当 INTEGRATION_S3_ENDPOINT 指向真实可用的 S3 兼容服务时执行，
 * 否则跳过（与 s3-storage.test.ts 同约定）。本测试只做 HeadBucket 探测，
 * 零副作用：不创建/删除任何对象与 bucket。
 */

const endpoint = process.env.INTEGRATION_S3_ENDPOINT;
const accessKeyId = process.env.INTEGRATION_S3_ACCESS_KEY_ID ?? "minioadmin";
const secretAccessKey = process.env.INTEGRATION_S3_SECRET_ACCESS_KEY ?? "minioadmin";
const publicBucket = process.env.INTEGRATION_S3_BUCKET_PUBLIC ?? "campus-public";
const privateBucket = process.env.INTEGRATION_S3_BUCKET_PRIVATE ?? "campus-private";

describe.skipIf(!endpoint)("真实依赖 readiness（runReadinessChecks × CI MinIO）", () => {
  it("REAL_MINIO：public+private bucket 均存在 → storage ok → ready（DB 真连）", async () => {
    vi.resetModules();
    process.env.S3_ENDPOINT = endpoint;
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ACCESS_KEY_ID = accessKeyId;
    process.env.S3_SECRET_ACCESS_KEY = secretAccessKey;
    process.env.S3_BUCKET_PUBLIC = publicBucket;
    process.env.S3_BUCKET_PRIVATE = privateBucket;
    process.env.S3_FORCE_PATH_STYLE = "true";
    // INTEGRATION_DATABASE_URL 在 CI verify job 指向真实 Postgres；
    // 本地无值时 env 校验可能失败，此时 DATABASE_URL 由全局 env 提供。
    if (process.env.INTEGRATION_DATABASE_URL && !process.env.DATABASE_URL) {
      process.env.DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
    }

    const { checkStorage, runReadinessChecks } = await import("@/lib/dependency-health");

    const storage = await checkStorage();
    expect(storage.status).toBe("ok");

    const report = await runReadinessChecks();
    // storage 必须双 bucket 全 ok；database 真实可达（CI 服务容器）；
    // redis 未配置 = 本地限流模式 → ok。任何失败都说明探针语义被破坏。
    expect(report.dependencies.storage).toBe("ok");
    expect(report.dependencies.database).toBe("ok");
    expect(report.status).toBe("ready");
  });

  it("REAL_MINIO_PRIVATE_MISSING：private 指向不存在的隔离 fixture bucket → storage failed → not_ready", async () => {
    vi.resetModules();
    process.env.S3_ENDPOINT = endpoint;
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ACCESS_KEY_ID = accessKeyId;
    process.env.S3_SECRET_ACCESS_KEY = secretAccessKey;
    process.env.S3_BUCKET_PUBLIC = publicBucket;
    // 隔离 fixture：名字唯一且绝不创建——只验证"缺失 → 失败"语义，
    // 不删除/不触碰任何共享 bucket（§56 禁止破坏共享 CI bucket）
    process.env.S3_BUCKET_PRIVATE = `campus-private-fixture-missing-${Date.now()}`;
    process.env.S3_FORCE_PATH_STYLE = "true";

    const { runReadinessChecks } = await import("@/lib/dependency-health");

    const report = await runReadinessChecks();

    expect(report.dependencies.storage).toBe("failed");
    expect(report.status).toBe("not_ready");
  });

  it("REAL_MINIO_PUBLIC_MISSING：public 指向不存在的隔离 fixture bucket → storage failed", async () => {
    vi.resetModules();
    process.env.S3_ENDPOINT = endpoint;
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ACCESS_KEY_ID = accessKeyId;
    process.env.S3_SECRET_ACCESS_KEY = secretAccessKey;
    process.env.S3_BUCKET_PUBLIC = `campus-public-fixture-missing-${Date.now()}`;
    process.env.S3_BUCKET_PRIVATE = privateBucket;
    process.env.S3_FORCE_PATH_STYLE = "true";

    const { checkStorage } = await import("@/lib/dependency-health");

    const storage = await checkStorage();
    expect(storage.status).toBe("failed");
  });
});
