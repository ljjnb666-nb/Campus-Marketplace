import { describe, expect, it } from "vitest";

import {
  DISPUTE_REVIEW_SLA_HOURS,
  computeDisputeDueAt,
  isDisputeOverdue,
} from "@/lib/disputes/dispute-sla";

/**
 * Phase 7G：dispute SLA 只读合同（SLA-D01/SLA-D03 的单元面；
 * 真实 PG 行为在 tests/integration/phase7g 覆盖）。
 */

describe("dispute-sla（frozen 48h，只读 overdue）", () => {
  it("SLA-D01：dueAt = createdAt + 48h（唯一运行时 origin 是创建时刻）", () => {
    expect(DISPUTE_REVIEW_SLA_HOURS).toBe(48);

    const createdAt = new Date("2026-09-19T00:00:00.000Z");
    expect(computeDisputeDueAt(createdAt).toISOString()).toBe(
      "2026-09-21T00:00:00.000Z",
    );
  });

  it("SLA-D02：active（OPEN/IN_REVIEW）且已过 due → overdue=true", () => {
    const now = new Date("2026-09-21T01:00:00.000Z");
    const dueAt = new Date("2026-09-21T00:00:00.000Z");

    expect(isDisputeOverdue({ status: "OPEN", dueAt }, now)).toBe(true);
    expect(isDisputeOverdue({ status: "IN_REVIEW", dueAt }, now)).toBe(true);
  });

  it("SLA-D02：未到 due / 恰好等于 due → false", () => {
    const dueAt = new Date("2026-09-21T00:00:00.000Z");

    expect(isDisputeOverdue({ status: "OPEN", dueAt }, new Date("2026-09-20T23:59:59.000Z"))).toBe(false);
    expect(isDisputeOverdue({ status: "OPEN", dueAt }, dueAt)).toBe(false);
  });

  it("SLA-D03：terminal（RESOLVED/CLOSED）永不过期（只读判定含 active 前置）", () => {
    const now = new Date("2026-09-22T00:00:00.000Z");
    const dueAt = new Date("2026-09-21T00:00:00.000Z");

    expect(isDisputeOverdue({ status: "RESOLVED", dueAt }, now)).toBe(false);
    expect(isDisputeOverdue({ status: "CLOSED", dueAt }, now)).toBe(false);
  });
});
