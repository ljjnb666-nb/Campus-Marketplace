import { describe, expect, it, vi } from "vitest";

import {
  MODERATION_CASE_SLA_HOURS,
  caseSlaDeadline,
  createModerationCaseForReportTx,
  isModerationCaseOverdue,
  syncModerationCaseOnReviewTx,
} from "@/lib/reports/moderation-case-sync";

/**
 * Phase 7E：SLA 常量与 case 时钟同步合同。
 */

const OPENED_AT = new Date("2026-09-16T10:00:00.000Z");
const DUE_AT = new Date("2026-09-18T10:00:00.000Z");

describe("SLA 常量与 OVERDUE 只读判定", () => {
  it("MODERATION_CASE_SLA_HOURS 冻结为 48（v1 不可配置）", () => {
    expect(MODERATION_CASE_SLA_HOURS).toBe(48);
  });

  it("caseSlaDeadline = openedAt + 48h（创建与 reopen 唯一计算点）", () => {
    expect(caseSlaDeadline(OPENED_AT).getTime()).toBe(DUE_AT.getTime());
  });

  it("isModerationCaseOverdue：closedAt=null ∧ dueAt<now；closed case 恒不超时", () => {
    const now = new Date("2026-09-18T11:00:00.000Z");
    expect(isModerationCaseOverdue({ closedAt: null, dueAt: DUE_AT }, now)).toBe(true);
    expect(isModerationCaseOverdue({ closedAt: null, dueAt: OPENED_AT }, now)).toBe(true);
    expect(
      isModerationCaseOverdue(
        { closedAt: null, dueAt: new Date("2026-09-18T12:00:00.000Z") },
        now,
      ),
    ).toBe(false);
    expect(
      isModerationCaseOverdue({ closedAt: new Date("2026-09-17T00:00:00.000Z"), dueAt: DUE_AT }, now),
    ).toBe(false);
  });
});

describe("syncModerationCaseOnReviewTx（transition ↔ case 时钟）", () => {
  function makeTx() {
    const update = vi.fn().mockImplementation(async () => ({
      id: "case-1",
      dueAt: new Date("2026-01-01T00:00:00.000Z"),
      closedAt: null,
    }));
    const create = vi.fn().mockImplementation(async () => ({
      id: "case-new",
      dueAt: new Date("2026-01-01T00:00:00.000Z"),
      closedAt: null,
    }));
    const tx = {
      moderationCase: { update, create },
    };
    return { tx, update, create };
  }

  const base = {
    reportId: "r1",
    existingCaseId: "case-1",
    campusId: "A",
    scopeKey: "CAMPUS:A",
    reportCreatedAt: OPENED_AT,
  };

  it("OPEN→IN_REVIEW：只清 closedAt，不重置 openedAt/dueAt", async () => {
    const { tx, update } = makeTx();
    await syncModerationCaseOnReviewTx(tx as never, {
      ...base,
      previousStatus: "OPEN",
      nextStatus: "IN_REVIEW",
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "case-1" },
        data: expect.objectContaining({ closedAt: null }),
      }),
    );
    const data = update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("openedAt");
    expect(data).not.toHaveProperty("dueAt");
  });

  it("RESOLVED/REJECTED → IN_REVIEW（reopen）：closedAt 清空且 openedAt/dueAt 以 now 重置", async () => {
    const { tx, update } = makeTx();
    await syncModerationCaseOnReviewTx(tx as never, {
      ...base,
      previousStatus: "RESOLVED",
      nextStatus: "IN_REVIEW",
    });
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.closedAt).toBeNull();
    expect(data.openedAt).toBeInstanceOf(Date);
    const reopenedAt = data.openedAt as Date;
    expect((data.dueAt as Date).getTime()).toBe(
      reopenedAt.getTime() + MODERATION_CASE_SLA_HOURS * 60 * 60 * 1000,
    );
  });

  it("terminal（RESOLVED）→ closedAt=now", async () => {
    const { tx, update } = makeTx();
    await syncModerationCaseOnReviewTx(tx as never, {
      ...base,
      previousStatus: "IN_REVIEW",
      nextStatus: "RESOLVED",
    });
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.closedAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty("openedAt");
  });

  it("缺行防御重建：openedAt 回落 report.createdAt（绝不用执行时刻）", async () => {
    const { tx, create } = makeTx();
    await syncModerationCaseOnReviewTx(tx as never, {
      ...base,
      existingCaseId: null,
      previousStatus: "OPEN",
      nextStatus: "IN_REVIEW",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          openedAt: OPENED_AT,
          dueAt: caseSlaDeadline(OPENED_AT),
          closedAt: null,
        }),
      }),
    );
  });
});

describe("createModerationCaseForReportTx（创建路径）", () => {
  it("openedAt=report 创建时刻，dueAt=+48h，lastActivityAt=openedAt", async () => {
    const create = vi.fn().mockResolvedValue({ id: "case-1" });
    const tx = { moderationCase: { create } };
    await createModerationCaseForReportTx(tx as never, {
      reportId: "r1",
      campusId: "A",
      scopeKey: "CAMPUS:A",
      openedAt: OPENED_AT,
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        reportId: "r1",
        campusId: "A",
        scopeKey: "CAMPUS:A",
        openedAt: OPENED_AT,
        dueAt: DUE_AT,
        lastActivityAt: OPENED_AT,
      },
      select: { id: true },
    });
  });
});
