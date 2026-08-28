import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

async function importEnvModule() {
  vi.resetModules();
  return import("@/lib/env");
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("env", () => {
  it("reads required variables and applies defaults", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/campus";
    process.env.NEXTAUTH_URL = "http://localhost:3000";
    process.env.NEXTAUTH_SECRET = "1234567890abcdef";
    delete process.env.APP_NAME;
    delete process.env.DEFAULT_CAMPUS_SLUG;
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET_PUBLIC;
    delete process.env.PUBLIC_ASSET_BASE_URL;
    delete process.env.PRIVATE_SIGNED_URL_TTL_SECONDS;
    delete process.env.STORAGE_QUOTA_MB;
    delete process.env.ASSET_ORPHAN_TTL_HOURS;
    delete process.env.VERIFICATION_ASSET_RETENTION_DAYS;
    delete process.env.S3_FORCE_PATH_STYLE;

    const { env } = await importEnvModule();

    expect(env.DATABASE_URL).toBe("postgresql://localhost:5432/campus");
    expect(env.NEXTAUTH_URL).toBe("http://localhost:3000");
    expect(env.NEXTAUTH_SECRET).toBe("1234567890abcdef");
    expect(env.APP_NAME).toBe("校园集市");
    expect(env.DEFAULT_CAMPUS_SLUG).toBe("main-campus");

    // S3 默认值指向本地 MinIO（开发/测试零配置，生产必须覆盖）
    expect(env.S3_ENDPOINT).toBe("http://localhost:9100");
    expect(env.S3_BUCKET_PUBLIC).toBe("campus-public");
    expect(env.S3_BUCKET_PRIVATE).toBe("campus-private");
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.PUBLIC_ASSET_BASE_URL).toBe("http://localhost:9100/campus-public");

    // 资源策略安全默认值：签名 URL 5 分钟 / 配额 500MB / 孤儿 24h / 认证材料保留 30 天
    expect(env.PRIVATE_SIGNED_URL_TTL_SECONDS).toBe(300);
    expect(env.STORAGE_QUOTA_MB).toBe(500);
    expect(env.ASSET_ORPHAN_TTL_HOURS).toBe(24);
    expect(env.VERIFICATION_ASSET_RETENTION_DAYS).toBe(30);
  });

  it("parses S3 storage variables from env strings", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/campus";
    process.env.NEXTAUTH_URL = "http://localhost:3000";
    process.env.NEXTAUTH_SECRET = "1234567890abcdef";
    process.env.S3_ENDPOINT = "https://example.r2.cloudflarestorage.com";
    process.env.S3_BUCKET_PUBLIC = "prod-public";
    process.env.S3_BUCKET_PRIVATE = "prod-private";
    process.env.PUBLIC_ASSET_BASE_URL = "https://cdn.example.com/prod-public";
    process.env.PRIVATE_SIGNED_URL_TTL_SECONDS = "600";
    process.env.STORAGE_QUOTA_MB = "1024";
    process.env.S3_FORCE_PATH_STYLE = "false";

    const { env } = await importEnvModule();

    expect(env.S3_ENDPOINT).toBe("https://example.r2.cloudflarestorage.com");
    expect(env.S3_BUCKET_PUBLIC).toBe("prod-public");
    expect(env.S3_BUCKET_PRIVATE).toBe("prod-private");
    expect(env.PUBLIC_ASSET_BASE_URL).toBe("https://cdn.example.com/prod-public");
    expect(env.PRIVATE_SIGNED_URL_TTL_SECONDS).toBe(600);
    expect(env.STORAGE_QUOTA_MB).toBe(1024);
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
  });

  it("throws when required variables are invalid", async () => {
    process.env.DATABASE_URL = "";
    process.env.NEXTAUTH_URL = "not-a-url";
    process.env.NEXTAUTH_SECRET = "short";

    await expect(importEnvModule()).rejects.toThrow();
  });

  it("rejects unsafe asset policy values", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/campus";
    process.env.NEXTAUTH_URL = "http://localhost:3000";
    process.env.NEXTAUTH_SECRET = "1234567890abcdef";
    // 签名 URL 有效期不得低于 60 秒（安全下限）
    process.env.PRIVATE_SIGNED_URL_TTL_SECONDS = "30";

    await expect(importEnvModule()).rejects.toThrow();
  });
});
