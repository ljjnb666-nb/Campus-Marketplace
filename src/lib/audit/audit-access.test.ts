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
  deriveAuditAccess,
  hasAnyAuditAccess,
  requireAuditReader,
} from "@/lib/audit/audit-access";

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

describe("deriveAuditAccess（与 7A/7B/7C 派生同构）", () => {
  it("GLOBAL audit.read → global=true（不要求 membership）", () => {
    const access = deriveAuditAccess(
      context({ grants: [{ roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["audit.read"] }] }),
    );
    expect(access).toEqual({ global: true, campusIds: [] });
  });

  it("CAMPUS audit.read ∧ ACTIVE membership → campusIds 收纳", () => {
    const access = deriveAuditAccess(
      context({
        activeCampusIds: ["A"],
        grants: [{ roleKey: "R", scope: "CAMPUS", campusId: "A", permissionKeys: ["audit.read"] }],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: ["A"] });
  });

  it("CAMPUS audit.read 无 ACTIVE membership → 不可见（inactive membership DENY）", () => {
    const access = deriveAuditAccess(
      context({
        activeCampusIds: [],
        grants: [{ roleKey: "R", scope: "CAMPUS", campusId: "A", permissionKeys: ["audit.read"] }],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: [] });
  });

  it("其它 permission / enforcement.read 不产生 audit access（语义分离）", () => {
    const access = deriveAuditAccess(
      context({
        activeCampusIds: ["A"],
        grants: [
          { roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["enforcement.read"] },
          { roleKey: "R2", scope: "CAMPUS", campusId: "A", permissionKeys: ["listing.moderate"] },
        ],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: [] });
  });

  it("null / 非激活账号 → 空 access", () => {
    expect(deriveAuditAccess(null)).toEqual({ global: false, campusIds: [] });
    expect(
      deriveAuditAccess(context({ accountActive: false, grants: [{ roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["audit.read"] }] })),
    ).toEqual({ global: false, campusIds: [] });
  });

  it("hasAnyAuditAccess：global 或 campus 任一即可", () => {
    expect(hasAnyAuditAccess({ global: true, campusIds: [] })).toBe(true);
    expect(hasAnyAuditAccess({ global: false, campusIds: ["A"] })).toBe(true);
    expect(hasAnyAuditAccess({ global: false, campusIds: [] })).toBe(false);
  });
});

describe("requireAuditReader（页面入口）", () => {
  it("有 audit.read scope → 返回 session", async () => {
    requireUser.mockResolvedValue({ id: "u1", name: "审计员" });
    loadAuthorizationContext.mockResolvedValue(
      context({ grants: [{ roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["audit.read"] }] }),
    );

    const session = await requireAuditReader();
    expect(session.access.global).toBe(true);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("零 scope → notFound（不泄露治理面存在性）", async () => {
    requireUser.mockResolvedValue({ id: "u1", name: "路人" });
    loadAuthorizationContext.mockResolvedValue(context());

    await expect(requireAuditReader()).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });
});
