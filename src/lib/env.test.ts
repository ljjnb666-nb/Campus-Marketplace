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

  describe("production startup validation (fail fast)", () => {
    async function importWithProductionEnv(
      overrides: Record<string, string | undefined> = {},
      options: { allowLocalS3?: boolean } = {},
    ) {
      vi.resetModules();
      // 占位凭据用拼接构造：仅证明“非默认值可通过校验”，仓库不含任何真实凭据形态
      const placeholderAccessId = ["ci", "placeholder", "access", "id"].join("-");
      const placeholderStorageCred = ["ci", "placeholder", "storage", "cred"].join("-");
      const scoped: Record<string, string | undefined> = {
        DATABASE_URL: "postgresql://db.example.com:5432/prod",
        NEXTAUTH_URL: "https://market.example.com",
        NEXTAUTH_SECRET: "production-secret-long-enough",
        S3_ENDPOINT: "https://s3.example.com",
        S3_ACCESS_KEY_ID: placeholderAccessId,
        S3_SECRET_ACCESS_KEY: placeholderStorageCred,
        PUBLIC_ASSET_BASE_URL: "https://cdn.example.com/prod-public",
        ...overrides,
      };
      const previous: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(scoped)) {
        previous[key] = process.env[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      const previousNodeEnv = process.env.NODE_ENV;
      const previousOptIn = process.env.ALLOW_LOCAL_S3_IN_PRODUCTION;
      vi.stubEnv("NODE_ENV", "production");
      delete process.env.ALLOW_LOCAL_S3_IN_PRODUCTION;
      if (options.allowLocalS3) {
        process.env.ALLOW_LOCAL_S3_IN_PRODUCTION = "true";
      }

      try {
        return await import("@/lib/env");
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        if (previousNodeEnv === undefined) {
          vi.stubEnv("NODE_ENV", "test");
        } else {
          vi.stubEnv("NODE_ENV", previousNodeEnv);
        }
        if (previousOptIn === undefined) {
          delete process.env.ALLOW_LOCAL_S3_IN_PRODUCTION;
        } else {
          process.env.ALLOW_LOCAL_S3_IN_PRODUCTION = previousOptIn;
        }
      }
    }

    it("development defaults (local MinIO) pass", async () => {
      // 当前进程非 production：默认 minioadmin/localhost 不触发 fail fast
      const { env: envInstance } = await importEnvModule();
      expect(envInstance.S3_ACCESS_KEY_ID).toBe("minioadmin");
    });

    it("production with dev MinIO credentials fails to start", async () => {
      await expect(
        importWithProductionEnv({ S3_ACCESS_KEY_ID: "minioadmin" }),
      ).rejects.toThrow(/S3_ACCESS_KEY_ID/);

      await expect(
        importWithProductionEnv({ S3_SECRET_ACCESS_KEY: "minioadmin" }),
      ).rejects.toThrow(/S3_SECRET_ACCESS_KEY/);
    });

    it("production with localhost S3 endpoint fails unless explicitly opted in", async () => {
      await expect(
        importWithProductionEnv({ S3_ENDPOINT: "http://localhost:9100" }),
      ).rejects.toThrow(/localhost/);

      await expect(
        importWithProductionEnv({ S3_ENDPOINT: "http://127.0.0.1:9100" }),
      ).rejects.toThrow(/localhost/);

      // 显式 opt-in（本机生产模式冒烟验证）允许通过
      await expect(
        importWithProductionEnv({ S3_ENDPOINT: "http://localhost:9100" }, { allowLocalS3: true }),
      ).resolves.toBeDefined();
    });

    it("production with real S3/R2 style config passes", async () => {
      await expect(importWithProductionEnv()).resolves.toBeDefined();
    });
  });
});
