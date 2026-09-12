import { describe, expect, it, vi } from "vitest";

import {
  deriveAppealReviewAccess,
  deriveAppealReviewCapabilities,
  canReviewScope,
} from "@/lib/appeals/reviewer-access";
import type { AuthorizationContext } from "@/lib/rbac/service";

// 本文件只测纯函数；reviewer-access 顶层的 server-auth/next-navigation 导入链
// 与本测试无关，按 server-auth.test.ts 同款 mock 隔离（不依赖 env）。
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: vi.fn() } } }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }), redirect: vi.fn() }));

/**
 * Phase 7A ACCESS-01..05（Planning Repair 1/2 冻结）：
 * deriveAppealReviewAccess 纯函数映射 + capability hints。
 * 语义必须与中央 RBAC hasPermission 同构（GLOBAL 不要求 membership；
 * campus = grant ∧ ACTIVE membership）。
 */

function context(overrides: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    userId: "viewer",
    accountActive: true,
    activeCampusIds: [],
    grants: [],
    ...overrides,
  };
}

function grant(
  scope: "GLOBAL" | "CAMPUS",
  permissionKeys: string[],
  campusId: string | null = null,
) {
  return { roleKey: "R", scope, campusId, permissionKeys };
}

describe("ACCESS-01：GLOBAL appeal.review + 零 membership → 放行", () => {
  it("global=true，campusIds 为空", () => {
    const access = deriveAppealReviewAccess(
      context({ grants: [grant("GLOBAL", ["appeal.review"])] }),
    );
    expect(access).toEqual({ global: true, campusIds: [] });
    // GLOBAL 宽度：任意校区 scope 亦可审（Repair 1 冻结）
    expect(canReviewScope(access, { kind: "CAMPUS", campusId: "any" })).toBe(true);
    expect(canReviewScope(access, { kind: "GLOBAL" })).toBe(true);
  });
});

describe("ACCESS-02：campus A grant + ACTIVE membership@A → 允许 A", () => {
  it("campusIds=[A]", () => {
    const access = deriveAppealReviewAccess(
      context({
        activeCampusIds: ["A"],
        grants: [grant("CAMPUS", ["appeal.review"], "A")],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: ["A"] });
    expect(canReviewScope(access, { kind: "CAMPUS", campusId: "A" })).toBe(true);
  });
});

describe("ACCESS-03：campus A grant + SUSPENDED membership → 无有效 access", () => {
  it("SUSPENDED 不进 activeCampusIds → campusIds 空", () => {
    const access = deriveAppealReviewAccess(
      context({
        activeCampusIds: [], // SUSPENDED membership 不产生 ACTIVE campus
        grants: [grant("CAMPUS", ["appeal.review"], "A")],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: [] });
    expect(canReviewScope(access, { kind: "CAMPUS", campusId: "A" })).toBe(false);
  });
});

describe("ACCESS-04：campus A grant + LEFT/缺失 membership → 无有效 access", () => {
  it("无 ACTIVE membership → campusIds 空", () => {
    const access = deriveAppealReviewAccess(
      context({ grants: [grant("CAMPUS", ["appeal.review"], "A")] }),
    );
    expect(access).toEqual({ global: false, campusIds: [] });
  });

  it("membership 在其它校区不命中", () => {
    const access = deriveAppealReviewAccess(
      context({
        activeCampusIds: ["B"],
        grants: [grant("CAMPUS", ["appeal.review"], "A")],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: [] });
  });
});

describe("ACCESS-05：permission 撤销 → 无有效 access", () => {
  it("grant 不含 appeal.review → 空", () => {
    const access = deriveAppealReviewAccess(
      context({
        activeCampusIds: ["A"],
        grants: [grant("CAMPUS", ["report.review"], "A")],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: [] });
  });

  it("完全无 grant → 空", () => {
    expect(deriveAppealReviewAccess(context())).toEqual({ global: false, campusIds: [] });
  });

  it("非激活账号 → 空（DEFAULT_DENY）", () => {
    expect(
      deriveAppealReviewAccess(
        context({
          accountActive: false,
          activeCampusIds: ["A"],
          grants: [grant("GLOBAL", ["appeal.review"])],
        }),
      ),
    ).toEqual({ global: false, campusIds: [] });
    expect(deriveAppealReviewAccess(null)).toEqual({ global: false, campusIds: [] });
  });
});

describe("campusIds 去重与 GLOBAL 兼容", () => {
  it("同一校区多 grant 去重", () => {
    const access = deriveAppealReviewAccess(
      context({
        activeCampusIds: ["A", "B"],
        grants: [
          grant("CAMPUS", ["appeal.review"], "A"),
          grant("CAMPUS", ["appeal.review", "report.review"], "A"),
          grant("CAMPUS", ["appeal.review"], "B"),
        ],
      }),
    );
    expect(access.campusIds).toEqual(["A", "B"]);
  });

  it("GLOBAL reviewer 兼持 campus grant：global=true 且 campusIds 照常并入", () => {
    const access = deriveAppealReviewAccess(
      context({
        activeCampusIds: ["A"],
        grants: [grant("GLOBAL", ["appeal.review"]), grant("CAMPUS", ["appeal.review"], "A")],
      }),
    );
    expect(access).toEqual({ global: true, campusIds: ["A"] });
  });

  it("campus-only reviewer 不可审 GLOBAL scope（Q-04 语义）", () => {
    const access = deriveAppealReviewAccess(
      context({
        activeCampusIds: ["A"],
        grants: [grant("CAMPUS", ["appeal.review"], "A")],
      }),
    );
    expect(canReviewScope(access, { kind: "GLOBAL" })).toBe(false);
  });
});

describe("capability hints（W1 呈现便利；域服务恒为最终权威）", () => {
  const globalReviewerContext = context({ grants: [grant("GLOBAL", ["appeal.review"])] });

  it("SUBMITTED：仅 canBeginReview", () => {
    const caps = deriveAppealReviewCapabilities({
      context: globalReviewerContext,
      status: "SUBMITTED",
      scope: { kind: "GLOBAL" },
    });
    expect(caps).toEqual({ canBeginReview: true, canUphold: false, canGrant: false });
  });

  it("IN_REVIEW：canUphold；有 user.suspend GLOBAL → canGrant", () => {
    const caps = deriveAppealReviewCapabilities({
      context: context({ grants: [grant("GLOBAL", ["appeal.review", "user.suspend"])] }),
      status: "IN_REVIEW",
      scope: { kind: "GLOBAL" },
    });
    expect(caps).toEqual({ canBeginReview: false, canUphold: true, canGrant: true });
  });

  it("IN_REVIEW：无恢复权 → canUphold=true / canGrant=false（A-15 UI 提示）", () => {
    const caps = deriveAppealReviewCapabilities({
      context: globalReviewerContext,
      status: "IN_REVIEW",
      scope: { kind: "GLOBAL" },
    });
    expect(caps).toEqual({ canBeginReview: false, canUphold: true, canGrant: false });
  });

  it("CAMPUS scope：canGrant 需 exact campus campus.manage", () => {
    const campusManager = context({
      activeCampusIds: ["A"],
      grants: [grant("CAMPUS", ["appeal.review"], "A")],
    });
    expect(
      deriveAppealReviewCapabilities({
        context: campusManager,
        status: "IN_REVIEW",
        scope: { kind: "CAMPUS", campusId: "A" },
      }),
    ).toEqual({ canBeginReview: false, canUphold: true, canGrant: false });

    const campusReviewerWithManage = context({
      activeCampusIds: ["A"],
      grants: [grant("CAMPUS", ["appeal.review", "campus.manage"], "A")],
    });
    expect(
      deriveAppealReviewCapabilities({
        context: campusReviewerWithManage,
        status: "IN_REVIEW",
        scope: { kind: "CAMPUS", campusId: "A" },
      }).canGrant,
    ).toBe(true);

    // GLOBAL reviewer（无 campus.manage@A）对 CAMPUS scope 不可 GRANT：
    // 恢复权按 canonical seam 要求 exact campus
    expect(
      deriveAppealReviewCapabilities({
        context: globalReviewerContext,
        status: "IN_REVIEW",
        scope: { kind: "CAMPUS", campusId: "A" },
      }).canGrant,
    ).toBe(false);
  });

  it("terminal 状态：全部 false", () => {
    const caps = deriveAppealReviewCapabilities({
      context: context({ grants: [grant("GLOBAL", ["appeal.review", "user.suspend"])] }),
      status: "UPHELD",
      scope: { kind: "GLOBAL" },
    });
    expect(caps).toEqual({ canBeginReview: false, canUphold: false, canGrant: false });
  });
});
