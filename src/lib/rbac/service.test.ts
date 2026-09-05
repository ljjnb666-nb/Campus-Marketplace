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
  hasFullAdminSurfaceAccess,
  hasPermission,
  loadAuthorizationContext,
} from "@/lib/rbac/service";
import { ADMIN_SURFACE_PERMISSION_KEYS } from "@/lib/rbac/permissions";

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

  it("collects ALL active membership campus ids（多校区模型）", async () => {
    mockFindUnique.mockResolvedValue(
      buildUserRow({
        memberships: [
          { id: "m-1", campusId: "campus-a", status: "ACTIVE" },
          { id: "m-2", campusId: "campus-b", status: "ACTIVE" },
        ],
      }),
    );

    const context = await loadAuthorizationContext("user-1");

    expect(context?.activeCampusIds).toEqual(["campus-a", "campus-b"]);
  });

  it("exposes the ACTIVE-only filter in the membership query（PENDING/SUSPENDED/LEFT 不进入上下文）", async () => {
    mockFindUnique.mockResolvedValue(buildUserRow({}));

    await loadAuthorizationContext("user-1");

    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          memberships: expect.objectContaining({
            where: { status: "ACTIVE" },
          }),
        }),
      }),
    );
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

describe("hasPermission（DEFAULT_DENY + active membership gate）", () => {
  const globalAdmin = {
    userId: "user-1",
    accountActive: true,
    activeCampusIds: [],
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

  it("GLOBAL + active account + no membership => ALLOW（平台管理员不受 membership 限制）", () => {
    expect(globalAdmin.activeCampusIds).toEqual([]);
    expect(hasPermission(globalAdmin, "verification.review")).toBe(true);
    expect(hasPermission(globalAdmin, "verification.review", "campus-z")).toBe(true);
  });

  it.each([
    ["missing membership", [] as string[]],
    ["PENDING/REJECTED/SUSPENDED/LEFT membership（不进入 activeCampusIds）", [] as string[]],
  ])("CAMPUS grant + %s => DENY", (_label, activeCampusIds) => {
    const reviewer = {
      userId: "user-2",
      accountActive: true,
      activeCampusIds,
      grants: [
        {
          roleKey: "CAMPUS_REVIEWER",
          scope: "CAMPUS" as const,
          campusId: "campus-a",
          permissionKeys: ["verification.review"],
        },
      ],
    };

    expect(hasPermission(reviewer, "verification.review", "campus-a")).toBe(false);
  });

  it("CAMPUS + exact ACTIVE campus => ALLOW", () => {
    const reviewer = {
      userId: "user-2",
      accountActive: true,
      activeCampusIds: ["campus-a"],
      grants: [
        {
          roleKey: "CAMPUS_REVIEWER",
          scope: "CAMPUS" as const,
          campusId: "campus-a",
          permissionKeys: ["verification.review"],
        },
      ],
    };

    expect(hasPermission(reviewer, "verification.review", "campus-a")).toBe(true);
  });

  it("CAMPUS + ACTIVE membership in a different campus => DENY（wrong active campus）", () => {
    const reviewer = {
      userId: "user-2",
      accountActive: true,
      activeCampusIds: ["campus-b"],
      grants: [
        {
          roleKey: "CAMPUS_REVIEWER",
          scope: "CAMPUS" as const,
          campusId: "campus-a",
          permissionKeys: ["verification.review"],
        },
      ],
    };

    expect(hasPermission(reviewer, "verification.review", "campus-a")).toBe(false);
    expect(hasPermission(reviewer, "verification.review", "campus-b")).toBe(false);
  });

  it("keeps denying campus grants without a target campus", () => {
    const reviewer = {
      userId: "user-2",
      accountActive: true,
      activeCampusIds: ["campus-a"],
      grants: [
        {
          roleKey: "CAMPUS_REVIEWER",
          scope: "CAMPUS" as const,
          campusId: "campus-a",
          permissionKeys: ["verification.review"],
        },
      ],
    };

    expect(hasPermission(reviewer, "verification.review")).toBe(false);
  });
});

describe("hasFullAdminSurfaceAccess（legacy full-admin 等价）", () => {
  function globalGrant(permissionKeys: string[]) {
    return {
      roleKey: "CUSTOM_GLOBAL",
      scope: "GLOBAL" as const,
      campusId: null,
      permissionKeys,
    };
  }

  it("allows only a GLOBAL grant covering the full legacy admin permission set", () => {
    const fullAdmin = {
      userId: "user-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [globalGrant([...ADMIN_SURFACE_PERMISSION_KEYS])],
    };

    expect(hasFullAdminSurfaceAccess(fullAdmin)).toBe(true);
  });

  it("denies a limited GLOBAL role（细粒度全局权限 ≠ legacy 超管）", () => {
    const limited = {
      userId: "user-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [globalGrant(["report.review"])],
    };

    expect(hasFullAdminSurfaceAccess(limited)).toBe(false);
  });

  it("denies拼接 multiple partial GLOBAL grants", () => {
    const stitched = {
      userId: "user-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [
        globalGrant(ADMIN_SURFACE_PERMISSION_KEYS.slice(0, 5)),
        globalGrant(ADMIN_SURFACE_PERMISSION_KEYS.slice(5)),
      ],
    };

    expect(hasFullAdminSurfaceAccess(stitched)).toBe(false);
  });

  it("denies campus-scoped grants even when covering the full set", () => {
    const campusFull = {
      userId: "user-1",
      accountActive: true,
      activeCampusIds: ["campus-a"],
      grants: [
        {
          roleKey: "CAMPUS_SUPER",
          scope: "CAMPUS" as const,
          campusId: "campus-a",
          permissionKeys: [...ADMIN_SURFACE_PERMISSION_KEYS],
        },
      ],
    };

    expect(hasFullAdminSurfaceAccess(campusFull)).toBe(false);
  });

  it("denies null context", () => {
    expect(hasFullAdminSurfaceAccess(null)).toBe(false);
  });
});

describe("hasAnyPermission", () => {
  it("requires at least one matching permission", () => {
    const context = {
      userId: "user-1",
      accountActive: true,
      activeCampusIds: [],
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
