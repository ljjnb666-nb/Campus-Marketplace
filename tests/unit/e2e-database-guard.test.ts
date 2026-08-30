import { describe, expect, it } from "vitest";

import {
  assertE2EDatabaseIsolation,
  isExplicitE2EDatabaseName,
  sanitizeDatabaseUrl,
} from "../../scripts/e2e-database-guard";

const loopbackE2E = "postgresql://e2euser:e2epass@localhost:5432/campus_e2e?schema=public";

describe("sanitizeDatabaseUrl（日志脱敏）", () => {
  it("隐藏用户名/密码/query，仅保留 scheme/host/port/dbname", () => {
    const sanitized = sanitizeDatabaseUrl(
      "postgresql://myuser:s3cretpass@db.internal:5432/mydb?sslmode=require",
    );
    expect(sanitized).toBe("postgresql://***:***@db.internal:5432/mydb");
    expect(sanitized).not.toContain("myuser");
    expect(sanitized).not.toContain("s3cretpass");
    expect(sanitized).not.toContain("sslmode");
  });

  it("无法解析的 URL 输出占位符而非原文", () => {
    expect(sanitizeDatabaseUrl("not-a-url")).toBe("<unparseable-url>");
  });
});

describe("isExplicitE2EDatabaseName", () => {
  it("e2e 作为独立语义段时视为 E2E 命名", () => {
    expect(isExplicitE2EDatabaseName("e2e")).toBe(true);
    expect(isExplicitE2EDatabaseName("campus_e2e")).toBe(true);
    expect(isExplicitE2EDatabaseName("e2e_campus")).toBe(true);
    expect(isExplicitE2EDatabaseName("app-e2e-1")).toBe(true);
    expect(isExplicitE2EDatabaseName("app.e2e")).toBe(true);
  });

  it("粘连/含糊命名与 prod/postgres 命名不视为 E2E", () => {
    expect(isExplicitE2EDatabaseName("e2etest")).toBe(false);
    expect(isExplicitE2EDatabaseName("test")).toBe(false);
    expect(isExplicitE2EDatabaseName("campus_test")).toBe(false);
    expect(isExplicitE2EDatabaseName("prod")).toBe(false);
    expect(isExplicitE2EDatabaseName("prod_e2e")).toBe(true); // E2E 段匹配，由硬拒名单兜底
  });
});

describe("assertE2EDatabaseIsolation（E2E destructive reset 生产安全闸门）", () => {
  // ---- 合法场景 ----
  it("放行：loopback + 明确 E2E 命名（本地/CI 标准形态）", () => {
    expect(() =>
      assertE2EDatabaseIsolation(loopbackE2E, {
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://app:apppass@localhost:5432/campus_marketplace",
      }),
    ).not.toThrow();
  });

  it("放行：CI 场景 DATABASE_URL 与 E2E_DATABASE_URL 指向同一 loopback E2E 库", () => {
    expect(() =>
      assertE2EDatabaseIsolation(loopbackE2E, {
        NODE_ENV: "test",
        DATABASE_URL: loopbackE2E,
      }),
    ).not.toThrow();
  });

  it("放行：loopback + E2E 命名 + 无 DATABASE_URL", () => {
    expect(() => assertE2EDatabaseIsolation(loopbackE2E, { NODE_ENV: "test" })).not.toThrow();
  });

  // ---- 拒绝：NODE_ENV=production 无任何 override ----
  it("拒绝 NODE_ENV=production（即使 E2E_DESTRUCTIVE_RESET_ALLOWED=1）", () => {
    expect(() =>
      assertE2EDatabaseIsolation(loopbackE2E, {
        NODE_ENV: "production",
        E2E_DESTRUCTIVE_RESET_ALLOWED: "1",
      }),
    ).toThrow(/NODE_ENV=production/);
  });

  // ---- 拒绝：remote host + test db + 无显式 override ----
  it("拒绝 remote host + e2e 命名 + 无显式 override", () => {
    expect(() =>
      assertE2EDatabaseIsolation("postgresql://e2euser:e2epass@db.internal:5432/campus_e2e", {
        NODE_ENV: "test",
      }),
    ).toThrow(/allow policy/);
  });

  it("放行：remote host + e2e 命名 + E2E_DESTRUCTIVE_RESET_ALLOWED=1（显式 override）", () => {
    expect(() =>
      assertE2EDatabaseIsolation("postgresql://e2euser:e2epass@db.internal:5432/campus_e2e", {
        NODE_ENV: "test",
        E2E_DESTRUCTIVE_RESET_ALLOWED: "1",
      }),
    ).not.toThrow();
  });

  it("拒绝 remote host + 粘连命名 e2etest（即使带 override）", () => {
    expect(() =>
      assertE2EDatabaseIsolation("postgresql://u:p@db.internal:5432/e2etest", {
        NODE_ENV: "test",
        E2E_DESTRUCTIVE_RESET_ALLOWED: "1",
      }),
    ).toThrow(/allow policy/);
  });

  // ---- 拒绝：production-looking db / 维护库 ----
  it.each(["prod", "production", "campus_prod", "campus-production", "prod_e2e", "postgres"])(
    "拒绝疑似生产/维护库名 %s（loopback 也不行）",
    (name) => {
      expect(() =>
        assertE2EDatabaseIsolation(`postgresql://postgres:postgres@localhost:5432/${name}`, {
          NODE_ENV: "test",
        }),
      ).toThrow(/allow policy/);
    },
  );

  // ---- 拒绝：与 production DATABASE_URL 同库 ----
  it("拒绝与 DATABASE_URL 指向同一非 E2E 库", () => {
    expect(() =>
      assertE2EDatabaseIsolation(
        "postgresql://postgres:postgres@db.internal:5432/app?schema=public",
        {
          NODE_ENV: "test",
          DATABASE_URL: "postgresql://postgres:otherpass@db.internal:5432/app?connection_limit=10",
        },
      ),
    ).toThrow(/allow policy/);
  });

  it("拒绝与 production DATABASE_URL 同库即使库名带 e2e（remote host 无 override）", () => {
    expect(() =>
      assertE2EDatabaseIsolation(
        "postgresql://postgres:postgres@db.internal:5432/campus_e2e",
        {
          NODE_ENV: "test",
          DATABASE_URL: "postgresql://postgres:postgres@db.internal:5432/campus_e2e",
        },
      ),
    ).toThrow(/allow policy/);
  });

  // ---- 拒绝：malformed URL ----
  it("拒绝缺少数据库名的 URL", () => {
    expect(() =>
      assertE2EDatabaseIsolation("postgresql://postgres:postgres@localhost:5432/", {
        NODE_ENV: "test",
      }),
    ).toThrow(/缺少数据库名/);
  });

  it("拒绝完全非法的 URL", () => {
    expect(() =>
      assertE2EDatabaseIsolation("not-a-url", { NODE_ENV: "test" }),
    ).toThrow(/无法解析/);
  });
});
