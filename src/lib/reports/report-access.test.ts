import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUserMock, loadAuthorizationContextMock, notFoundMock } = vi.hoisted(() => ({
  requireUserMock: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser: requireUserMock,
}));

vi.mock("@/lib/rbac/service", () => ({
  loadAuthorizationContext: loadAuthorizationContextMock,
}));

import {
  canReviewReportScope,
  deriveReportReviewAccess,
  hasAnyReportReviewAccess,
  requireReportReviewer,
} from "@/lib/reports/report-access";
import type { AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7E：report.review access 派生 + 治理页入口 resolver 合同
 * （DEFAULT_DENY，与 hasPermission / 7A requireAppealReviewer 同构）。
 */

function context(overrides: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    userId: "user-1",
    accountActive: true,
    activeCampusIds: [],
    grants: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserMock.mockResolvedValue({ id: "viewer-1", email: "r@x", name: "V", role: "STUDENT" });
});

describe("deriveReportReviewAccess", () => {
  it("GLOBAL report.review → global=true（不要求 membership）", () => {
    const access = deriveReportReviewAccess(
      context({
        grants: [
          { roleKey: "PLATFORM_ADMIN", scope: "GLOBAL", campusId: null, permissionKeys: ["report.review"] },
        ],
      }),
    );
    expect(access).toEqual({ global: true, campusIds: [] });
    expect(hasAnyReportReviewAccess(access)).toBe(true);
  });

  it("CAMPUS report.review@A → 仅 membership ACTIVE 时纳入 campusIds", () => {
    const access = deriveReportReviewAccess(
      context({
        activeCampusIds: ["A"],
        grants: [
          { roleKey: "CAMPUS_REPORT_REVIEWER", scope: "CAMPUS", campusId: "A", permissionKeys: ["report.review"] },
        ],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: ["A"] });
  });

  it("membership 缺失/非激活的 CAMPUS grant 不产生 scope（grant ∧ membership 求交）", () => {
    const access = deriveReportReviewAccess(
      context({
        activeCampusIds: [],
        grants: [
          { roleKey: "CAMPUS_REPORT_REVIEWER", scope: "CAMPUS", campusId: "A", permissionKeys: ["report.review"] },
        ],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: [] });
    expect(hasAnyReportReviewAccess(access)).toBe(false);
  });

  it("非激活账号 / null context → 空 access（DEFAULT_DENY）", () => {
    const inactive = deriveReportReviewAccess(
      context({
        accountActive: false,
        grants: [
          { roleKey: "PLATFORM_ADMIN", scope: "GLOBAL", campusId: null, permissionKeys: ["report.review"] },
        ],
      }),
    );
    expect(inactive).toEqual({ global: false, campusIds: [] });
    expect(deriveReportReviewAccess(null)).toEqual({ global: false, campusIds: [] });
  });

  it("其他 permission 的 grant 不产生 report access（零扩权）", () => {
    const access = deriveReportReviewAccess(
      context({
        grants: [
          { roleKey: "R1", scope: "GLOBAL", campusId: null, permissionKeys: ["appeal.review", "listing.moderate"] },
          { roleKey: "R2", scope: "CAMPUS", campusId: "A", permissionKeys: ["appeal.review"] },
        ],
        activeCampusIds: ["A"],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: [] });
  });
});

describe("canReviewReportScope（UNSCOPED 仅 GLOBAL）", () => {
  const globalAccess = { global: true, campusIds: [] as string[] };
  const campusA = { global: false, campusIds: ["A"] };

  it("UNSCOPED：GLOBAL 放行，campus reviewer 拒绝", () => {
    expect(canReviewReportScope(globalAccess, { kind: "UNSCOPED" })).toBe(true);
    expect(canReviewReportScope(campusA, { kind: "UNSCOPED" })).toBe(false);
  });

  it("CAMPUS：exact campus 放行；其他校区/GLOBAL-only 拒绝", () => {
    expect(canReviewReportScope(campusA, { kind: "CAMPUS", campusId: "A" })).toBe(true);
    expect(canReviewReportScope(campusA, { kind: "CAMPUS", campusId: "B" })).toBe(false);
    expect(canReviewReportScope(globalAccess, { kind: "CAMPUS", campusId: "B" })).toBe(true);
  });
});

describe("requireReportReviewer（页面统一入口）", () => {
  it("GLOBAL scope → 返回 session/context/access", async () => {
    const ctx = {
      userId: "viewer-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [
        { roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["report.review"] },
      ],
    };
    loadAuthorizationContextMock.mockResolvedValue(ctx);

    const session = await requireReportReviewer();

    expect(session.user.id).toBe("viewer-1");
    expect(session.context).toBe(ctx);
    expect(session.access).toEqual({ global: true, campusIds: [] });
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("campus scope（grant ∧ ACTIVE membership）→ 放行", async () => {
    loadAuthorizationContextMock.mockResolvedValue({
      userId: "viewer-1",
      accountActive: true,
      activeCampusIds: ["A"],
      grants: [
        { roleKey: "CAMPUS_REPORT_REVIEWER", scope: "CAMPUS", campusId: "A", permissionKeys: ["report.review"] },
      ],
    });

    const session = await requireReportReviewer();

    expect(session.access).toEqual({ global: false, campusIds: ["A"] });
  });

  it("零有效 scope → notFound（不泄露治理面存在性）", async () => {
    loadAuthorizationContextMock.mockResolvedValue({
      userId: "viewer-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [],
    });

    await expect(requireReportReviewer()).rejects.toThrow("NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalled();
  });

  it("context 缺失（用户不存在）→ notFound", async () => {
    loadAuthorizationContextMock.mockResolvedValue(null);

    await expect(requireReportReviewer()).rejects.toThrow("NOT_FOUND");
  });
});

describe("hasAnyReportReviewAccess（root gate 分量）", () => {
  it("global 或任意 campus scope 即为 true；空 access 恒 false", () => {
    expect(hasAnyReportReviewAccess({ global: true, campusIds: [] })).toBe(true);
    expect(hasAnyReportReviewAccess({ global: false, campusIds: ["A"] })).toBe(true);
    expect(hasAnyReportReviewAccess({ global: false, campusIds: [] })).toBe(false);
    expect(hasAnyReportReviewAccess(deriveReportReviewAccess(null))).toBe(false);
  });
});
