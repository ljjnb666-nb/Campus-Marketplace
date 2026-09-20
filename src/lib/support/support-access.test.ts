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
  canManageSupportScope,
  deriveSupportManageAccess,
  hasAnySupportManageAccess,
} from "@/lib/support/support-access";
import type { AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7G：support agent access 派生（DEFAULT_DENY；UNSCOPED 仅 GLOBAL 合同）。
 */

function ctx(
  grants: AuthorizationContext["grants"],
  activeCampusIds: string[] = [],
  accountActive = true,
): AuthorizationContext {
  return { userId: "u1", accountActive, activeCampusIds, grants };
}

function campusGrant(campusId: string) {
  return { roleKey: "R", scope: "CAMPUS" as const, campusId, permissionKeys: ["support.manage"] };
}

function globalGrant() {
  return { roleKey: "R", scope: "GLOBAL" as const, campusId: null, permissionKeys: ["support.manage"] };
}

describe("deriveSupportManageAccess（DEFAULT_DENY）", () => {
  it("null / 非激活 → 空 access；GLOBAL → global=true", () => {
    expect(deriveSupportManageAccess(null)).toEqual({ global: false, campusIds: [] });
    expect(deriveSupportManageAccess(ctx([globalGrant()], [], false))).toEqual({
      global: false,
      campusIds: [],
    });
    expect(deriveSupportManageAccess(ctx([globalGrant()]))).toEqual({
      global: true,
      campusIds: [],
    });
  });

  it("CAMPUS grant ∧ ACTIVE membership 求交；去重", () => {
    expect(deriveSupportManageAccess(ctx([campusGrant("A")], []))).toEqual({
      global: false,
      campusIds: [],
    });
    expect(deriveSupportManageAccess(ctx([campusGrant("A"), campusGrant("A")], ["A"]))).toEqual({
      global: false,
      campusIds: ["A"],
    });
  });

  it("canManageSupportScope：UNSCOPED 仅 GLOBAL；CAMPUS exact；malformed 拒绝", () => {
    const global = { global: true, campusIds: [] };
    const campusA = { global: false, campusIds: ["A"] };

    expect(canManageSupportScope(global, { campusId: null, scopeKey: "UNSCOPED" })).toBe(true);
    expect(canManageSupportScope(campusA, { campusId: null, scopeKey: "UNSCOPED" })).toBe(false);
    expect(canManageSupportScope(campusA, { campusId: "A", scopeKey: "CAMPUS:A" })).toBe(true);
    expect(canManageSupportScope(campusA, { campusId: "B", scopeKey: "CAMPUS:B" })).toBe(false);
    // malformed 交叉对 fail closed（GLOBAL 也不放行）
    expect(canManageSupportScope(global, { campusId: "A", scopeKey: "CAMPUS:B" })).toBe(false);
    expect(canManageSupportScope(campusA, { campusId: null, scopeKey: "CAMPUS:A" })).toBe(false);
  });

  it("hasAnySupportManageAccess：union 分量", () => {
    expect(hasAnySupportManageAccess({ global: true, campusIds: [] })).toBe(true);
    expect(hasAnySupportManageAccess({ global: false, campusIds: [] })).toBe(false);
  });

  it("requireSupportAgent：零 scope → notFound", async () => {
    requireUserMock.mockResolvedValue({ id: "u1" });
    loadAuthorizationContextMock.mockResolvedValue(ctx([], []));
    notFoundMock.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });

    const { requireSupportAgent } = await import("@/lib/support/support-access");
    await expect(requireSupportAgent()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalled();
  });
});
