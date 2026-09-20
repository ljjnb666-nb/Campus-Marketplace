import { beforeEach, describe, expect, it, vi } from "vitest";

const { appealFindMany, campusFindMany } = vi.hoisted(() => ({
  appealFindMany: vi.fn(),
  campusFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    appeal: { findMany: appealFindMany },
    campus: { findMany: campusFindMany },
  },
}));

import {
  decodeAppealReviewCursor,
  encodeAppealReviewCursor,
  loadAuthorizedAppealQueue,
} from "@/lib/appeals/review-queue";

/**
 * Phase 7G：appeal 队列 SLA 重排后的 cursor canonical 纪律 + 排序合同
 * （7G 排序冻结：reviewDueAt ASC, createdAt ASC, id ASC）。
 */

const GLOBAL_ACCESS = { global: true, campusIds: [] as string[] };

beforeEach(() => {
  vi.clearAllMocks();
  campusFindMany.mockResolvedValue([{ id: "A" }]);
});

describe("appeal review cursor（FR03 canonical 纪律）", () => {
  const cursor = {
    reviewDueAt: new Date("2026-09-21T00:00:00.000Z"),
    createdAt: new Date("2026-09-19T00:00:00.000Z"),
    id: "appeal-1",
  };

  it("encode → decode 往返相等", () => {
    const raw = encodeAppealReviewCursor(cursor);
    expect(decodeAppealReviewCursor(raw)).toEqual(cursor);
  });

  it("非 canonical raw（空白字母表 / 键集漂移 / 非规范 ISO / 空 id）→ null", () => {
    const raw = encodeAppealReviewCursor(cursor);
    expect(decodeAppealReviewCursor(raw.replace(/-/g, "+").replace(/_/g, "/") + "=")).toBeNull();

    const wrongKeys = Buffer.from(
      JSON.stringify({ reviewDueAt: cursor.reviewDueAt.toISOString(), id: "d" }),
    ).toString("base64url");
    expect(decodeAppealReviewCursor(wrongKeys)).toBeNull();

    const nonCanonical = Buffer.from(
      JSON.stringify({
        reviewDueAt: "2026-09-21T00:00:00Z",
        createdAt: cursor.createdAt.toISOString(),
        id: "d",
      }),
    ).toString("base64url");
    expect(decodeAppealReviewCursor(nonCanonical)).toBeNull();

    const emptyId = Buffer.from(
      JSON.stringify({
        reviewDueAt: cursor.reviewDueAt.toISOString(),
        createdAt: cursor.createdAt.toISOString(),
        id: "",
      }),
    ).toString("base64url");
    expect(decodeAppealReviewCursor(emptyId)).toBeNull();

    expect(decodeAppealReviewCursor("!!invalid!!")).toBeNull();
  });
});

describe("loadAuthorizedAppealQueue（7G 重排：ASC keyset + overdue 只读）", () => {
  const cursor = {
    reviewDueAt: new Date("2026-09-21T00:00:00.000Z"),
    createdAt: new Date("2026-09-19T00:00:00.000Z"),
    id: "appeal-1",
  };

  it("fail-closed：零有效 scope 永远空页（零 DB 调用）", async () => {
    const page = await loadAuthorizedAppealQueue({
      viewerId: "v1",
      access: { global: false, campusIds: [] },
      limit: 25,
    });
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(appealFindMany).not.toHaveBeenCalled();
  });

  it("排序冻结：orderBy = reviewDueAt ASC, createdAt ASC, id ASC；cursor 进 keyset 条件", async () => {
    appealFindMany.mockResolvedValue([]);

    await loadAuthorizedAppealQueue({
      viewerId: "v1",
      access: GLOBAL_ACCESS,
      limit: 25,
      cursor,
    });

    const call = appealFindMany.mock.calls.at(-1)![0];
    expect(call.orderBy).toEqual([
      { reviewDueAt: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ]);
    expect(call.take).toBe(26);
    expect(call.where.AND ?? call.where.OR).toBeDefined();
    expect(JSON.stringify(call.where)).toContain("reviewDueAt");
  });

  it("DTO 携带 reviewDueAt/overdue；overdue 仅 active 命中", async () => {
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const past = new Date(Date.now() - 1 * 60 * 60 * 1000);
    appealFindMany.mockResolvedValue([
      {
        id: "a1",
        status: "SUBMITTED",
        createdAt: new Date("2026-09-19T00:00:00.000Z"),
        reviewDueAt: past,
        enforcementAction: {
          type: "ACCOUNT_SUSPEND",
          actorId: "someone-else",
          campusId: null,
          campus: null,
          target: { name: "申诉人甲" },
        },
      },
      {
        id: "a2",
        status: "IN_REVIEW",
        createdAt: new Date("2026-09-19T00:00:00.000Z"),
        reviewDueAt: future,
        enforcementAction: {
          type: "MEMBERSHIP_SUSPEND",
          actorId: "viewer-1",
          campusId: "A",
          campus: { name: "甲校区" },
          target: { name: "申诉人乙" },
        },
      },
    ]);

    const page = await loadAuthorizedAppealQueue({
      viewerId: "viewer-1",
      access: GLOBAL_ACCESS,
      limit: 25,
    });

    expect(page.items[0]).toMatchObject({
      id: "a1",
      overdue: true,
      selfReview: false,
      appellantName: "申诉人甲",
    });
    expect(page.items[1]).toMatchObject({
      id: "a2",
      overdue: false,
      selfReview: true,
      campusName: "甲校区",
    });
    expect(page.nextCursor).toBeNull();
  });

  it("hasMore → nextCursor 编码（codec 往返）", async () => {
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000);
    appealFindMany.mockResolvedValue([
      {
        id: "a1",
        status: "SUBMITTED",
        createdAt: new Date("2026-09-19T00:00:00.000Z"),
        reviewDueAt: future,
        enforcementAction: {
          type: "ACCOUNT_SUSPEND",
          actorId: "x",
          campusId: null,
          campus: null,
          target: { name: "申诉人" },
        },
      },
      {
        id: "a2",
        status: "SUBMITTED",
        createdAt: new Date("2026-09-19T00:00:00.000Z"),
        reviewDueAt: future,
        enforcementAction: {
          type: "ACCOUNT_SUSPEND",
          actorId: "x",
          campusId: null,
          campus: null,
          target: { name: "申诉人" },
        },
      },
    ]);

    const page = await loadAuthorizedAppealQueue({
      viewerId: "v1",
      access: GLOBAL_ACCESS,
      limit: 1,
    });

    expect(page.items).toHaveLength(1);
    expect(decodeAppealReviewCursor(page.nextCursor!)).toEqual({
      reviewDueAt: future,
      createdAt: new Date("2026-09-19T00:00:00.000Z"),
      id: "a1",
    });
  });
});
