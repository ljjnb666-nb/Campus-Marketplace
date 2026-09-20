import { describe, expect, it, vi } from "vitest";

const { notFoundMock, requireUserMock, loadAuthorizationContextMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(),
  requireUserMock: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: notFoundMock }));
vi.mock("@/lib/server-auth", () => ({ requireUser: requireUserMock }));
vi.mock("@/lib/rbac/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac/service")>();
  return { ...actual, loadAuthorizationContext: loadAuthorizationContextMock };
});

import {
  canReviewDisputeCampus,
  deriveDisputeReviewAccess,
  hasAnyDisputeReviewAccess,
} from "@/lib/disputes/dispute-access";
import type { AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7G：dispute reviewer access 派生（纯函数，DEFAULT_DENY 合同；
 * 与 7A/7E derive* 同构）。
 */

function ctx(
  grants: AuthorizationContext["grants"],
  activeCampusIds: string[] = [],
  accountActive = true,
): AuthorizationContext {
  return { userId: "u1", accountActive, activeCampusIds, grants };
}

function campusGrant(campusId: string, keys: string[] = ["dispute.review"]) {
  return { roleKey: "R", scope: "CAMPUS" as const, campusId, permissionKeys: keys };
}

function globalGrant(keys: string[] = ["dispute.review"]) {
  return { roleKey: "R", scope: "GLOBAL" as const, campusId: null, permissionKeys: keys };
}

describe("deriveDisputeReviewAccess（DEFAULT_DENY）", () => {
  it("null / 非激活账号 → 空 access", () => {
    expect(deriveDisputeReviewAccess(null)).toEqual({ global: false, campusIds: [] });
    expect(
      deriveDisputeReviewAccess(ctx([globalGrant()], [], false)),
    ).toEqual({ global: false, campusIds: [] });
  });

  it("GLOBAL dispute.review → global=true（不要求 membership）", () => {
    expect(deriveDisputeReviewAccess(ctx([globalGrant()]))).toEqual({
      global: true,
      campusIds: [],
    });
  });

  it("CAMPUS dispute.review@A 仅在 membership@A ACTIVE 时进入 campusIds", () => {
    expect(deriveDisputeReviewAccess(ctx([campusGrant("A")], []))).toEqual({
      global: false,
      campusIds: [],
    });
    expect(deriveDisputeReviewAccess(ctx([campusGrant("A")], ["A"]))).toEqual({
      global: false,
      campusIds: ["A"],
    });
  });

  it("无关 permission 的 grant 不产生 access；campusIds 去重", () => {
    expect(
      deriveDisputeReviewAccess(ctx([campusGrant("A", ["report.review"])], ["A"])),
    ).toEqual({ global: false, campusIds: [] });
    expect(
      deriveDisputeReviewAccess(ctx([campusGrant("A"), campusGrant("A")], ["A"])),
    ).toEqual({ global: false, campusIds: ["A"] });
  });

  it("canReviewDisputeCampus / hasAnyDisputeReviewAccess", () => {
    expect(canReviewDisputeCampus({ global: true, campusIds: [] }, "A")).toBe(true);
    expect(canReviewDisputeCampus({ global: false, campusIds: ["A"] }, "A")).toBe(true);
    expect(canReviewDisputeCampus({ global: false, campusIds: ["A"] }, "B")).toBe(false);
    expect(canReviewDisputeCampus({ global: false, campusIds: [] }, "A")).toBe(false);

    expect(hasAnyDisputeReviewAccess({ global: true, campusIds: [] })).toBe(true);
    expect(hasAnyDisputeReviewAccess({ global: false, campusIds: ["A"] })).toBe(true);
    expect(hasAnyDisputeReviewAccess({ global: false, campusIds: [] })).toBe(false);
  });

  it("requireDisputeReviewer：零 scope → notFound（不泄露治理面存在性）", async () => {
    requireUserMock.mockResolvedValue({ id: "u1" });
    loadAuthorizationContextMock.mockResolvedValue(ctx([], []));
    notFoundMock.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });

    const { requireDisputeReviewer } = await import("@/lib/disputes/dispute-access");
    await expect(requireDisputeReviewer()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalled();
  });
});
