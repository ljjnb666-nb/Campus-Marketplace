import { describe, expect, it } from "vitest";

import { decodeReportCursor, encodeReportCursor } from "@/lib/reports/report-query";

/**
 * Phase 7E：queue cursor（UNTRUSTED 分页位置）的纯逻辑合同。
 * DB 授权谓词/DTO 最小化/campus 选项派生由真实 PostgreSQL 集成测试覆盖。
 */

const BASE = {
  dueAt: new Date("2026-09-18T10:00:00.000Z"),
  createdAt: new Date("2026-09-16T10:00:00.000Z"),
  id: "case-1",
};

describe("report queue cursor（全 tuple 稳定 tie-break）", () => {
  it("encode→decode roundtrip 保留 (dueAt, createdAt, id) 全列", () => {
    const decoded = decodeReportCursor(encodeReportCursor(BASE));
    expect(decoded).not.toBeNull();
    expect(decoded!.dueAt.getTime()).toBe(BASE.dueAt.getTime());
    expect(decoded!.createdAt.getTime()).toBe(BASE.createdAt.getTime());
    expect(decoded!.id).toBe(BASE.id);
  });

  it("畸形/缺失字段/坏时间戳 → null（安全失败态）", () => {
    expect(decodeReportCursor("not-base64url!!")).toBeNull();
    expect(decodeReportCursor(Buffer.from(JSON.stringify({ id: "x" })).toString("base64url"))).toBeNull();
    expect(
      decodeReportCursor(
        Buffer.from(
          JSON.stringify({ dueAt: "nope", createdAt: BASE.createdAt.toISOString(), id: "x" }),
        ).toString("base64url"),
      ),
    ).toBeNull();
    expect(decodeReportCursor("")).toBeNull();
  });
});
