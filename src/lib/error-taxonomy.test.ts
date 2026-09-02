import { describe, expect, it } from "vitest";

import { classifyError, classifyHttpStatus } from "@/lib/error-taxonomy";

describe("error-taxonomy（TASK 3：运维错误分类）", () => {
  it("业务 status 属性优先：404 → NOT_FOUND/info/非 server fault", () => {
    const error = Object.assign(new Error("not found"), { status: 404 });

    expect(classifyError(error)).toEqual({
      category: "NOT_FOUND",
      httpStatus: 404,
      logLevel: "info",
      isServerFault: false,
    });
  });

  it.each([
    [400, "VALIDATION", "warn"],
    [401, "AUTHENTICATION", "info"],
    [403, "AUTHORIZATION", "warn"],
    [404, "NOT_FOUND", "info"],
    [409, "CONFLICT", "warn"],
    [429, "RATE_LIMIT", "warn"],
  ] as const)("HTTP %s → %s / %s / 非故障", (status, category, logLevel) => {
    const classification = classifyHttpStatus(status);
    expect(classification.category).toBe(category);
    expect(classification.logLevel).toBe(logLevel);
    expect(classification.isServerFault).toBe(false);
  });

  it("未知异常 → INTERNAL/error/server fault", () => {
    expect(classifyError(new Error("boom"))).toEqual({
      category: "INTERNAL",
      httpStatus: 500,
      logLevel: "error",
      isServerFault: true,
    });
  });

  it("Prisma 错误族：P2002→CONFLICT、P2025→NOT_FOUND、其余→DATABASE", () => {
    const conflict = Object.assign(new Error("Unique constraint failed"), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    });
    expect(classifyError(conflict).category).toBe("CONFLICT");

    const missing = Object.assign(new Error("Record not found"), {
      name: "PrismaClientKnownRequestError",
      code: "P2025",
    });
    expect(classifyError(missing).category).toBe("NOT_FOUND");

    const broken = Object.assign(new Error("Connection terminated"), {
      name: "PrismaClientKnownRequestError",
      code: "P1001",
    });
    const classification = classifyError(broken);
    expect(classification.category).toBe("DATABASE");
    expect(classification.isServerFault).toBe(true);
  });

  it("Redis 错误族 → CACHE/server fault（warn 级：有本地降级）", () => {
    const error = Object.assign(new Error("Reached the max retries per request limit"), {
      name: "MaxRetriesPerRequestError",
    });

    const classification = classifyError(error);
    expect(classification.category).toBe("CACHE");
    expect(classification.isServerFault).toBe(true);
    expect(classification.logLevel).toBe("warn");
  });

  it("S3 SDK 错误（$metadata）→ STORAGE/server fault", () => {
    const error = Object.assign(new Error("AccessDenied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });

    const classification = classifyError(error);
    expect(classification.category).toBe("STORAGE");
    expect(classification.isServerFault).toBe(true);
  });

  it("classifyHttpStatus：非预期状态码归入 INTERNAL（5xx 语义）", () => {
    expect(classifyHttpStatus(500).isServerFault).toBe(true);
    expect(classifyHttpStatus(503).category).toBe("INTERNAL");
  });
});
