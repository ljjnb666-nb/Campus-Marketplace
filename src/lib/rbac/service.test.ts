import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindUnique } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: mockFindUnique,
    },
  },
}));

import {
  hasAnyPermission,
  hasPermission,
  loadAuthorizationContext,
} from "@/lib/rbac/service";

const PLATFORM_ADMIN_GRANT = {
  campusId: null,
  role: {
    key: "PLATFORM_ADMIN",
    scope: "GLOBAL" as const,
    rolePermissions: [
      { permission: { key: "verification.review" } },
      { permission: { key: "asset.sensitive.read" } },
      { permission: { key: "rbac.role.assign" } },
    ],
  },
};

function buildUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    status: "ACTIVE",
    deletedAt: null,
    erasedAt: null,
    memberships: [],
    userRoles: [] as unknown[],
    ...overrides,
  };
}

beforeEach(() => {
  mockFindUnique.mockReset();
});

describe("loadAuthorizationContext", () => {
  it("returns null when the user row is missing", async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(loadAuthorizationContext("ghost")).resolves.toBeNull();
  });

  it("flags inactive accounts（suspended / deleted / erased）", async () => {
    mockFindUnique.mockResolvedValue(buildUserRow({ status: "SUSPENDED" }));
    const suspended = await loadAuthorizationContext("user-1");
    expect(suspended?.accountActive).toBe(false);

    mockFindUnique.mockResolvedValue(buildUserRow({ erasedAt: new Date() }));
    const erased = await loadAuthorizationContext("user-1");
    expect(erased?.accountActive).toBe(false);
  });

  it("resolves the single active membership deterministically", async () => {
    mockFindUnique.mockResolvedValue(
      buildUserRow({
        memberships: [{ id: "m-1", campusId: "campus-a", status: "ACTIVE" }],
      }),
    );

    const context = await loadAuthorizationContext("user-1");

    expect(context?.activeMembership).toEqual({
      id: "m-1",
      campusId: "campus-a",
      status: "ACTIVE",
    });
  });

  it("flattens role-permission grants", async () => {
    mockFindUnique.mockResolvedValue(buildUserRow({ userRoles: [PLATFORM_ADMIN_GRANT] }));

    const context = await loadAuthorizationContext("user-1");

    expect(context?.grants).toEqual([
      {
        roleKey: "PLATFORM_ADMIN",
        scope: "GLOBAL",
        campusId: null,
        permissionKeys: ["verification.review", "asset.sensitive.read", "rbac.role.assign"],
      },
    ]);
  });
});

describe("hasPermission（DEFAULT_DENY）", () => {
  const globalAdmin = {
    userId: "user-1",
    accountActive: true,
    activeMembership: null,
    grants: [
      {
        roleKey: "PLATFORM_ADMIN",
        scope: "GLOBAL" as const,
        campusId: null,
        permissionKeys: ["verification.review", "asset.sensitive.read"],
      },
    ],
  };

  it("denies when the context is missing or the account is inactive", () => {
    expect(hasPermission(null, "verification.review")).toBe(false);

    const inactive = { ...globalAdmin, accountActive: false };
    expect(hasPermission(inactive, "verification.review")).toBe(false);
  });

  it("denies unknown permissions even for the platform admin grant", () => {
    const unknown = "payment.refund" as never;
    expect(hasPermission(globalAdmin, unknown)).toBe(false);
  });

  it("allows global grants regardless of the target campus", () => {
    expect(hasPermission(globalAdmin, "verification.review")).toBe(true);
    expect(hasPermission(globalAdmin, "verification.review", "campus-z")).toBe(true);
  });

  it("allows campus grants only for the exact target campus", () => {
    const campusReviewer = {
      userId: "user-2",
      accountActive: true,
      activeMembership: null,
      grants: [
        {
          roleKey: "CAMPUS_REVIEWER",
          scope: "CAMPUS" as const,
          campusId: "campus-a",
          permissionKeys: ["verification.review"],
        },
      ],
    };

    expect(hasPermission(campusReviewer, "verification.review", "campus-a")).toBe(true);
    // 跨校区（关键安全不变量）
    expect(hasPermission(campusReviewer, "verification.review", "campus-b")).toBe(false);
    // 未指明目标校区的 campus-scoped 授权 → DENY
    expect(hasPermission(campusReviewer, "verification.review")).toBe(false);
  });
});

describe("hasAnyPermission", () => {
  it("requires at least one matching permission", () => {
    const context = {
      userId: "user-1",
      accountActive: true,
      activeMembership: null,
      grants: [
        {
          roleKey: "R",
          scope: "GLOBAL" as const,
          campusId: null,
          permissionKeys: ["report.review"],
        },
      ],
    };

    expect(hasAnyPermission(context, ["verification.review", "report.review"])).toBe(true);
    expect(hasAnyPermission(context, ["verification.review"])).toBe(false);
    expect(hasAnyPermission(null, ["verification.review"])).toBe(false);
  });
});
