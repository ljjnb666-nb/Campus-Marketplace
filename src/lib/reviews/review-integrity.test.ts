import { describe, expect, it } from "vitest";

import {
  REVIEW_WINDOW_MS,
  computeReviewDeadline,
  deriveReviewPublicationStatus,
  isCanonicallyVisibleReview,
  isPublicationConditionMet,
  isReviewWindowOpen,
} from "@/lib/reviews/review-integrity";

const COMPLETED_AT = new Date("2026-09-20T10:00:00.000Z");

function blindAt(completedAt: Date): Date {
  return computeReviewDeadline(completedAt);
}

describe("REVIEW_WINDOW_MS（§4 唯一定义）", () => {
  it("= 7 天，且不允许出现第二份窗口常量推导", () => {
    expect(REVIEW_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("computeReviewDeadline", () => {
  it("completedAt + 7 天", () => {
    expect(computeReviewDeadline(COMPLETED_AT).getTime()).toBe(
      COMPLETED_AT.getTime() + REVIEW_WINDOW_MS,
    );
  });
});

describe("isReviewWindowOpen（§39 WINDOW-01..04）", () => {
  it("WINDOW-01：T + 6d23h → 允许", () => {
    const now = new Date(COMPLETED_AT.getTime() + 6 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000);
    expect(isReviewWindowOpen(now, COMPLETED_AT)).toBe(true);
  });

  it("WINDOW-02：now == T + 7d → DENY（严格小于）", () => {
    const now = computeReviewDeadline(COMPLETED_AT);
    expect(isReviewWindowOpen(now, COMPLETED_AT)).toBe(false);
  });

  it("WINDOW-03：now > T + 7d → DENY", () => {
    const now = new Date(COMPLETED_AT.getTime() + REVIEW_WINDOW_MS + 60_000);
    expect(isReviewWindowOpen(now, COMPLETED_AT)).toBe(false);
  });

  it("WINDOW-04：completedAt = null → fail closed", () => {
    expect(isReviewWindowOpen(new Date(), null)).toBe(false);
  });
});

describe("isPublicationConditionMet（§6）", () => {
  it("publishedAt != null → 满足", () => {
    expect(
      isPublicationConditionMet(
        { publishedAt: COMPLETED_AT, blindUntil: blindAt(COMPLETED_AT) },
        COMPLETED_AT,
      ),
    ).toBe(true);
  });

  it("publishedAt == null 且 blindUntil 未到 → 不满足", () => {
    expect(
      isPublicationConditionMet(
        { publishedAt: null, blindUntil: blindAt(COMPLETED_AT) },
        new Date(COMPLETED_AT.getTime() + 1000),
      ),
    ).toBe(false);
  });

  it("publishedAt == null 且 blindUntil == now → 满足（query-time 到期公开）", () => {
    expect(
      isPublicationConditionMet(
        { publishedAt: null, blindUntil: blindAt(COMPLETED_AT) },
        blindAt(COMPLETED_AT),
      ),
    ).toBe(true);
  });
});

describe("isCanonicallyVisibleReview（§8 完整公开条件）", () => {
  const blindReview = { publishedAt: null, blindUntil: blindAt(COMPLETED_AT) };

  it("COMPLETED + 无纠纷 + 未公开未到期 → 不可见（第一方 blind）", () => {
    expect(
      isCanonicallyVisibleReview(blindReview, {
        now: COMPLETED_AT,
        orderStatus: "COMPLETED",
        hasActiveDispute: false,
      }),
    ).toBe(false);
  });

  it("COMPLETED + 无纠纷 + 到期 → 可见（VIS-03，无 scheduler）", () => {
    expect(
      isCanonicallyVisibleReview(blindReview, {
        now: blindAt(COMPLETED_AT),
        orderStatus: "COMPLETED",
        hasActiveDispute: false,
      }),
    ).toBe(true);
  });

  it("IN_DISPUTE → 保留但不可见（VIS-04，即使已 published）", () => {
    expect(
      isCanonicallyVisibleReview(
        { publishedAt: COMPLETED_AT, blindUntil: blindAt(COMPLETED_AT) },
        { now: COMPLETED_AT, orderStatus: "IN_DISPUTE", hasActiveDispute: true },
      ),
    ).toBe(false);
  });

  it("RESTORE_PREVIOUS → COMPLETED → 重新可见（VIS-05）", () => {
    expect(
      isCanonicallyVisibleReview(
        { publishedAt: COMPLETED_AT, blindUntil: blindAt(COMPLETED_AT) },
        { now: COMPLETED_AT, orderStatus: "COMPLETED", hasActiveDispute: false },
      ),
    ).toBe(true);
  });

  it("CLOSED → 不公开（VIS-06，评价保留为历史事实）", () => {
    expect(
      isCanonicallyVisibleReview(
        { publishedAt: COMPLETED_AT, blindUntil: blindAt(COMPLETED_AT) },
        { now: COMPLETED_AT, orderStatus: "CLOSED", hasActiveDispute: false },
      ),
    ).toBe(false);
  });
});

describe("deriveReviewPublicationStatus（§9/§27 UI projection）", () => {
  const blindReview = { publishedAt: null, blindUntil: blindAt(COMPLETED_AT) };

  it("blind + 无纠纷 → BLIND_WAITING（等待双方完成评价后公开）", () => {
    expect(
      deriveReviewPublicationStatus(blindReview, {
        now: COMPLETED_AT,
        orderStatus: "COMPLETED",
        hasActiveDispute: false,
      }),
    ).toBe("BLIND_WAITING");
  });

  it("active dispute → DISPUTE_HIDDEN（即使已到期/已发布）", () => {
    expect(
      deriveReviewPublicationStatus(
        { publishedAt: COMPLETED_AT, blindUntil: blindAt(COMPLETED_AT) },
        { now: COMPLETED_AT, orderStatus: "IN_DISPUTE", hasActiveDispute: true },
      ),
    ).toBe("DISPUTE_HIDDEN");
  });

  it("已公开 + COMPLETED → PUBLISHED", () => {
    expect(
      deriveReviewPublicationStatus(
        { publishedAt: COMPLETED_AT, blindUntil: blindAt(COMPLETED_AT) },
        { now: COMPLETED_AT, orderStatus: "COMPLETED", hasActiveDispute: false },
      ),
    ).toBe("PUBLISHED");
  });

  it("CLOSED（纠纷关闭终局）→ 不按 PUBLISHED 展示", () => {
    expect(
      deriveReviewPublicationStatus(
        { publishedAt: COMPLETED_AT, blindUntil: blindAt(COMPLETED_AT) },
        { now: COMPLETED_AT, orderStatus: "CLOSED", hasActiveDispute: false },
      ),
    ).toBe("DISPUTE_HIDDEN");
  });
});
