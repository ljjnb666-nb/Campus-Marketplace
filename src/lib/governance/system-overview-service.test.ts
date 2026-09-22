import { afterEach, describe, expect, it, vi } from "vitest";

const { runReadinessChecks } = vi.hoisted(() => ({
  runReadinessChecks: vi.fn(),
}));

vi.mock("@/lib/dependency-health", () => ({ runReadinessChecks }));

import { loadSystemOverview } from "@/lib/governance/system-overview-service";

/**
 * SO04-SO07/SO08（service 层）：System Overview 复用 canonical readiness
 * SSOT（绝不第二套 DB ping/Redis policy/S3 health），fail-soft 不 throw，
 * DTO 仅 release + status enum（结构性无端点/凭据/原始错误）。
 */

const ORIGINAL_RELEASE_SHA = process.env.RELEASE_SHA;

afterEach(() => {
  if (ORIGINAL_RELEASE_SHA === undefined) {
    delete process.env.RELEASE_SHA;
  } else {
    process.env.RELEASE_SHA = ORIGINAL_RELEASE_SHA;
  }
  vi.clearAllMocks();
});

describe("loadSystemOverview（readiness SSOT 复用 + fail-soft + 安全边界）", () => {
  it("SO04：release 透传 RELEASE_SHA（与 /api/health release 同源）", async () => {
    process.env.RELEASE_SHA = "abc1234";
    runReadinessChecks.mockResolvedValue({
      status: "ready",
      dependencies: { database: "ok", redis: "ok", storage: "ok" },
      checks: [],
    });

    const overview = await loadSystemOverview();

    expect(overview.release).toBe("abc1234");
    expect(overview).toEqual({
      release: "abc1234",
      status: "ready",
      dependencies: { database: "ok", redis: "ok", storage: "ok" },
    });
  });

  it("release 缺省 → dev（与既有 /api/health fallback 同语义）", async () => {
    delete process.env.RELEASE_SHA;
    runReadinessChecks.mockResolvedValue({
      status: "ready",
      dependencies: { database: "ok", redis: "ok", storage: "ok" },
      checks: [],
    });

    const overview = await loadSystemOverview();

    expect(overview.release).toBe("dev");
  });

  it("SO05：database failed → 透传既有 not_ready 聚合（不发明第二套 taxonomy）", async () => {
    runReadinessChecks.mockResolvedValue({
      status: "not_ready",
      dependencies: { database: "failed", redis: "ok", storage: "ok" },
      checks: [],
    });

    const overview = await loadSystemOverview();

    expect(overview.status).toBe("not_ready");
    expect(overview.dependencies.database).toBe("failed");
  });

  it("SO06：redis degraded → 透传既有 degraded 聚合", async () => {
    runReadinessChecks.mockResolvedValue({
      status: "degraded",
      dependencies: { database: "ok", redis: "degraded", storage: "ok" },
      checks: [],
    });

    const overview = await loadSystemOverview();

    expect(overview.status).toBe("degraded");
    expect(overview.dependencies.redis).toBe("degraded");
  });

  it("SO07：storage failed → 透传既有 not_ready 聚合", async () => {
    runReadinessChecks.mockResolvedValue({
      status: "not_ready",
      dependencies: { database: "ok", redis: "ok", storage: "failed" },
      checks: [],
    });

    const overview = await loadSystemOverview();

    expect(overview.dependencies.storage).toBe("failed");
    expect(overview.status).toBe("not_ready");
  });

  it("§16 fail-soft：readiness 框架自身异常 → canonical enum 最坏组合，绝不 throw 500", async () => {
    runReadinessChecks.mockRejectedValue(new Error("readiness framework exploded"));

    const overview = await loadSystemOverview();

    expect(overview.status).toBe("not_ready");
    expect(overview.dependencies).toEqual({
      database: "failed",
      redis: "degraded",
      storage: "failed",
    });
  });

  it("SO08：DTO 仅 release + status enum——无端点/凭据/原始错误/路径字段", async () => {
    runReadinessChecks.mockResolvedValue({
      status: "ready",
      dependencies: { database: "ok", redis: "ok", storage: "ok" },
      checks: [
        {
          dependency: "database",
          status: "ok",
          durationMs: 3,
        },
      ],
    });
    process.env.RELEASE_SHA = "abc1234";

    const overview = await loadSystemOverview();
    const serialized = JSON.stringify(overview);

    expect(Object.keys(overview).sort()).toEqual(["dependencies", "release", "status"]);
    expect(Object.keys(overview.dependencies).sort()).toEqual(["database", "redis", "storage"]);
    for (const forbidden of [
      "postgres",
      "DATABASE_URL",
      "redis://",
      "s3",
      "endpoint",
      "secret",
      "token",
      "password",
      "error",
      "stack",
      "durationMs",
      "checks",
      "/",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
