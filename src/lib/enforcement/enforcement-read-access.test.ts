import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, loadAuthorizationContext, notFound } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/lib/rbac/service", () => ({
  loadAuthorizationContext,
}));

vi.mock("next/navigation", () => ({
  notFound,
}));

import {
  deriveEnforcementReadAccess,
  hasAnyEnforcementReadAccess,
  requireEnforcementReader,
} from "@/lib/enforcement/enforcement-read-access";

function context(overrides: Partial<{
  userId: string;
  accountActive: boolean;
  activeCampusIds: string[];
  grants: Array<{ roleKey: string; scope: "GLOBAL" | "CAMPUS"; campusId: string | null; permissionKeys: string[] }>;
}> = {}) {
  return {
    userId: "u1",
    accountActive: true,
    activeCampusIds: [] as string[],
    grants: [] as Array<{ roleKey: string; scope: "GLOBAL" | "CAMPUS"; campusId: string | null; permissionKeys: string[] }>,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("deriveEnforcementReadAccess（OPTION B 语义分离）", () => {
  it("GLOBAL enforcement.read → global=true", () => {
    const access = deriveEnforcementReadAccess(
      context({ grants: [{ roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["enforcement.read"] }] }),
    );
    expect(access).toEqual({ global: true, campusIds: [] });
  });

  it("CAMPUS enforcement.read ∧ ACTIVE membership → campusIds 收纳", () => {
    const access = deriveEnforcementReadAccess(
      context({
        activeCampusIds: ["A", "B"],
        grants: [
          { roleKey: "R", scope: "CAMPUS", campusId: "A", permissionKeys: ["enforcement.read"] },
        ],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: ["A"] });
  });

  it("mutation keys（user.suspend/campus.manage）与 audit.read 不产生 enforcement read access（禁止派生复用）", () => {
    const access = deriveEnforcementReadAccess(
      context({
        activeCampusIds: ["A"],
        grants: [
          { roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["user.suspend", "audit.read"] },
          { roleKey: "R2", scope: "CAMPUS", campusId: "A", permissionKeys: ["campus.manage"] },
        ],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: [] });
  });

  it("null / 非激活账号 → 空 access", () => {
    expect(deriveEnforcementReadAccess(null)).toEqual({ global: false, campusIds: [] });
    expect(
      deriveEnforcementReadAccess(context({ accountActive: false })),
    ).toEqual({ global: false, campusIds: [] });
  });

  it("hasAnyEnforcementReadAccess", () => {
    expect(hasAnyEnforcementReadAccess({ global: true, campusIds: [] })).toBe(true);
    expect(hasAnyEnforcementReadAccess({ global: false, campusIds: [] })).toBe(false);
  });
});

describe("requireEnforcementReader（页面入口）", () => {
  it("有 scope → 返回 session", async () => {
    requireUser.mockResolvedValue({ id: "u1", name: "执法读者" });
    loadAuthorizationContext.mockResolvedValue(
      context({ grants: [{ roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["enforcement.read"] }] }),
    );

    const session = await requireEnforcementReader();
    expect(session.access.global).toBe(true);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("零 scope → notFound", async () => {
    requireUser.mockResolvedValue({ id: "u1", name: "路人" });
    loadAuthorizationContext.mockResolvedValue(context());

    await expect(requireEnforcementReader()).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });
});
