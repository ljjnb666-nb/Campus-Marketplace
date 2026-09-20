import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, loadAuthorizationContext, hasPermission, notFound } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  hasPermission: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/rbac/service", () => ({ loadAuthorizationContext, hasPermission }));
vi.mock("next/navigation", () => ({ notFound }));

import type { AuthorizationContext } from "@/lib/rbac/service";
import {
  deriveCampusManageAccess,
  hasAnyCampusManageAccess,
  requireCampusManager,
} from "@/lib/campus/campus-admin-access";

function useCentralHasPermission() {
  hasPermission.mockImplementation(
    (
      context: {
        accountActive?: boolean;
        grants?: Array<{ scope: string; permissionKeys: string[] }>;
      } | null,
      permission: string,
    ) =>
      Boolean(
        context?.accountActive &&
          context.grants?.some(
            (grant) => grant.scope === "GLOBAL" && grant.permissionKeys.includes(permission),
          ),
      ),
  );
}

const activeContext: AuthorizationContext = {
  userId: "mgr-1",
  accountActive: true,
  activeCampusIds: [] as string[],
  grants: [],
};

beforeEach(() => {
  requireUser.mockReset();
  loadAuthorizationContext.mockReset();
  hasPermission.mockReset();
  notFound.mockClear();
  useCentralHasPermission();
});

describe("deriveCampusManageAccess（campus.manage = GLOBAL ONLY，§17 冻结）", () => {
  it("CA01：GLOBAL campus.manage → global=true", () => {
    const access = deriveCampusManageAccess({
      ...activeContext,
      grants: [
        { roleKey: "PLATFORM_ADMIN", scope: "GLOBAL", campusId: null, permissionKeys: ["campus.manage"] },
      ],
    });
    expect(access).toEqual({ global: true });
    expect(hasAnyCampusManageAccess(access)).toBe(true);
  });

  it("CA02：CAMPUS-scoped campus.manage（即使误配存在）→ global=false（租户边界 mutation GLOBAL only）", () => {
    const access = deriveCampusManageAccess({
      ...activeContext,
      activeCampusIds: ["A"],
      grants: [
        { roleKey: "CAMPUS_ADMIN", scope: "CAMPUS", campusId: "A", permissionKeys: ["campus.manage"] },
      ],
    });
    expect(access).toEqual({ global: false });
    expect(hasAnyCampusManageAccess(access)).toBe(false);
  });

  it("CA03：零 grant / 停用账号 / null context → global=false", () => {
    expect(deriveCampusManageAccess(activeContext)).toEqual({ global: false });
    expect(
      deriveCampusManageAccess({
        ...activeContext,
        accountActive: false,
        grants: [
          { roleKey: "P", scope: "GLOBAL", campusId: null, permissionKeys: ["campus.manage"] },
        ],
      }),
    ).toEqual({ global: false });
    expect(deriveCampusManageAccess(null)).toEqual({ global: false });
  });
});

describe("requireCampusManager（/governance/campuses 子树自守门）", () => {
  it("GLOBAL campus.manage → 返回 session", async () => {
    requireUser.mockResolvedValue({ id: "mgr-1", email: "m@x", name: "M" });
    loadAuthorizationContext.mockResolvedValue({
      ...activeContext,
      grants: [
        { roleKey: "PLATFORM_ADMIN", scope: "GLOBAL", campusId: null, permissionKeys: ["campus.manage"] },
      ],
    });

    const session = await requireCampusManager();

    expect(session.user.id).toBe("mgr-1");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("campus-scoped grant → notFound", async () => {
    requireUser.mockResolvedValue({ id: "u-1", email: "u@x", name: "U" });
    loadAuthorizationContext.mockResolvedValue({
      ...activeContext,
      activeCampusIds: ["A"],
      grants: [
        { roleKey: "CAMPUS_ADMIN", scope: "CAMPUS", campusId: "A", permissionKeys: ["campus.manage"] },
      ],
    });

    await expect(requireCampusManager()).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });
});
