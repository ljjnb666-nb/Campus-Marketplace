import { describe, expect, it } from "vitest";

import {
  SUPPORT_RESPONSE_SLA_HOURS,
  computeSupportTicketDueAt,
  isSupportTicketOverdue,
} from "@/lib/support/support-sla";

/**
 * Phase 7G：support SLA 只读合同（SLA-S01/SLA-S03 的单元面）。
 */

describe("support-sla（frozen 72h，只读 overdue）", () => {
  it("SLA-S01：dueAt = createdAt + 72h", () => {
    expect(SUPPORT_RESPONSE_SLA_HOURS).toBe(72);
    expect(computeSupportTicketDueAt(new Date("2026-09-19T00:00:00.000Z")).toISOString()).toBe(
      "2026-09-22T00:00:00.000Z",
    );
  });

  it("SLA-S02：active（OPEN/IN_PROGRESS）且已过 due → true；terminal → false", () => {
    const now = new Date("2026-09-22T01:00:00.000Z");
    const dueAt = new Date("2026-09-22T00:00:00.000Z");

    expect(isSupportTicketOverdue({ status: "OPEN", dueAt }, now)).toBe(true);
    expect(isSupportTicketOverdue({ status: "IN_PROGRESS", dueAt }, now)).toBe(true);
    expect(isSupportTicketOverdue({ status: "RESOLVED", dueAt }, now)).toBe(false);
    expect(isSupportTicketOverdue({ status: "CLOSED", dueAt }, now)).toBe(false);
  });
});
