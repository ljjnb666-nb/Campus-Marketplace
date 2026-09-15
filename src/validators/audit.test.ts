import { describe, expect, it } from "vitest";

import {
  AUDIT_MAX_PAGE_SIZE,
  auditDateRange,
  auditPageLimitSchema,
  auditQueueQuerySchema,
  decodeAuditCursor,
  encodeAuditCursor,
} from "@/validators/audit";

describe("audit queue 查询合同", () => {
  it("limit 缺席可选；越界拒绝；字符串 coerce", () => {
    expect(auditQueueQuerySchema.safeParse({}).success).toBe(true);
    expect(auditQueueQuerySchema.safeParse({ limit: "10" }).success).toBe(true);
    expect(auditQueueQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(auditQueueQuerySchema.safeParse({ limit: AUDIT_MAX_PAGE_SIZE + 1 }).success).toBe(false);
    expect(auditQueueQuerySchema.safeParse({ limit: "abc" }).success).toBe(false);
  });

  it("未知查询参数拒绝（strict，fail closed）", () => {
    expect(auditQueueQuerySchema.safeParse({ evil: "1" }).success).toBe(false);
  });

  it("日期过滤必须为 YYYY-MM-DD", () => {
    expect(auditQueueQuerySchema.safeParse({ from: "2026-09-15" }).success).toBe(true);
    expect(auditQueueQuerySchema.safeParse({ from: "2026/09/15" }).success).toBe(false);
    expect(auditQueueQuerySchema.safeParse({ to: "2026-09-15T10:00:00Z" }).success).toBe(false);
  });

  it("date range → UTC 全天确定边界", () => {
    expect(auditDateRange("2026-09-15", "2026-09-16")).toEqual({
      gte: new Date("2026-09-15T00:00:00.000Z"),
      lte: new Date("2026-09-16T23:59:59.999Z"),
    });
    expect(auditDateRange()).toEqual({});
  });
});

describe("audit cursor（base64url(JSON)，7A 同构）", () => {
  it("encode/decode 往返唯一", () => {
    const cursor = { createdAt: new Date("2026-09-15T08:30:00.000Z"), id: "cm Audit001" };
    const encoded = encodeAuditCursor(cursor);
    const decoded = decodeAuditCursor(encoded);
    expect(decoded).toEqual(cursor);
    expect(encodeAuditCursor({ createdAt: decoded!.createdAt, id: decoded!.id })).toBe(encoded);
  });

  it("畸形输入一律 null（R3/存在性安全：不抛错、不回退首页语义由调用方处理）", () => {
    expect(decodeAuditCursor("!!!not-base64url!!!")).toBeNull();
    // Buffer base64url 解码会静默剥离非法字符 → 解出非法 JSON → null
    expect(decodeAuditCursor(Buffer.from("not json").toString("base64url"))).toBeNull();
    expect(
      decodeAuditCursor(Buffer.from(JSON.stringify({ id: "only-id" })).toString("base64url")),
    ).toBeNull();
    expect(
      decodeAuditCursor(
        Buffer.from(JSON.stringify({ createdAt: "2026-13-99", id: "x" })).toString("base64url"),
      ),
    ).toBeNull();
    // 未知字段（strict payload）
    expect(
      decodeAuditCursor(
        Buffer.from(
          JSON.stringify({ createdAt: "2026-09-15T00:00:00.000Z", id: "x", extra: 1 }),
        ).toString("base64url"),
      ),
    ).toBeNull();
  });
});
