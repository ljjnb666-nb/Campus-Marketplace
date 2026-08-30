import { describe, expect, it } from "vitest";

import { assertE2EDatabaseIsolation } from "../../scripts/e2e-database-guard";

describe("assertE2EDatabaseIsolation（E2E destructive reset 生产安全闸门）", () => {
  it("放行指向隔离 E2E 库的常规场景", () => {
    expect(() =>
      assertE2EDatabaseIsolation(
        "postgresql://postgres:postgres@localhost:5432/campus_e2e?schema=public",
        { NODE_ENV: "test", DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/campus_marketplace" },
      ),
    ).not.toThrow();
  });

  it("拒绝 NODE_ENV=production", () => {
    expect(() =>
      assertE2EDatabaseIsolation(
        "postgresql://postgres:postgres@localhost:5432/campus_e2e",
        { NODE_ENV: "production" },
      ),
    ).toThrow("NODE_ENV=production");
  });

  it.each(["prod", "production", "campus_prod", "campus-production", "postgres"])(
    "拒绝疑似生产/维护库名 %s",
    (name) => {
      expect(() =>
        assertE2EDatabaseIsolation(
          `postgresql://postgres:postgres@localhost:5432/${name}`,
          { NODE_ENV: "test" },
        ),
      ).toThrow(/生产\/维护库/);
    },
  );

  it("拒绝 E2E_DATABASE_URL 与 DATABASE_URL 指向同一 host:port/db", () => {
    expect(() =>
      assertE2EDatabaseIsolation(
        "postgresql://postgres:postgres@db.internal:5432/app?schema=public",
        {
          NODE_ENV: "test",
          DATABASE_URL: "postgresql://postgres:otherpass@db.internal:5432/app?connection_limit=10",
        },
      ),
    ).toThrow(/同一数据库/);
  });

  it("同库但库名本身是 E2E 安全命名（CI 满足 prisma.config 校验的场景）放行", () => {
    expect(() =>
      assertE2EDatabaseIsolation(
        "postgresql://postgres:postgres@localhost:5432/campus_e2e?schema=public",
        {
          NODE_ENV: "test",
          DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/campus_e2e?schema=public",
        },
      ),
    ).not.toThrow();
  });

  it("同 host 不同 db 放行；缺少数据库名直接报错", () => {
    expect(() =>
      assertE2EDatabaseIsolation(
        "postgresql://postgres:postgres@db.internal:5432/app_e2e",
        {
          NODE_ENV: "test",
          DATABASE_URL: "postgresql://postgres:otherpass@db.internal:5432/app",
        },
      ),
    ).not.toThrow();

    expect(() =>
      assertE2EDatabaseIsolation("postgresql://postgres:postgres@db.internal:5432/", {
        NODE_ENV: "test",
      }),
    ).toThrow(/缺少数据库名/);
  });
});
