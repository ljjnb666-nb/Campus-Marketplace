import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getVerifiedSession,
  requireAdmin,
  requireUser,
} from "@/lib/server-auth";
import { ADMIN_SURFACE_PERMISSION_KEYS } from "@/lib/rbac/permissions";

const {
  mockAuth,
  mockRedirect,
  mockFindUnique,
  mockGetUserAcceptanceStatus,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRedirect: vi.fn(),
  mockFindUnique: vi.fn(),
  mockGetUserAcceptanceStatus: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: mockFindUnique,
    },
  },
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("@/lib/legal/policy-service", () => ({
  getUserAcceptanceStatus: mockGetUserAcceptanceStatus,
}));

const ACTIVE_USER = {
  id: "user-1",
  role: "STUDENT" as const,
  name: "小林",
  email: "lin@example.com",
  avatarUrl: null,
  verificationStatus: "VERIFIED",
  status: "ACTIVE" as const,
  deletedAt: null,
  erasedAt: null,
};

const COMPLIANT = {
  compliant: true,
  required: [],
  pending: [],
};

beforeEach(() => {
  mockAuth.mockReset();
  mockRedirect.mockReset();
  mockFindUnique.mockReset();
  mockGetUserAcceptanceStatus.mockReset();
  mockRedirect.mockImplementation((target: string) => {
    throw new Error(`REDIRECT:${target}`);
  });
  // 默认满足同意要求（consent gate 放行）
  mockGetUserAcceptanceStatus.mockResolvedValue(COMPLIANT);
});

describe("requireUser", () => {
  it("redirects to login when the session is missing", async () => {
    mockAuth.mockResolvedValue(null);

    await expect(requireUser()).rejects.toThrow("REDIRECT:/login");
    expect(mockRedirect).toHaveBeenCalledWith("/login");
  });

  it("redirects to login when the user is not found in database", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "stale-user", role: "STUDENT", name: "旧账号" },
    });
    mockFindUnique.mockResolvedValue(null);

    await expect(requireUser()).rejects.toThrow("REDIRECT:/login");
    expect(mockRedirect).toHaveBeenCalledWith("/login");
  });

  it("returns the authenticated user from database", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", role: "STUDENT", name: "小林" },
    });
    mockFindUnique.mockResolvedValue({ ...ACTIVE_USER });

    await expect(requireUser()).resolves.toEqual({ ...ACTIVE_USER });
  });

  it("rejects the session when the account has been suspended", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", role: "STUDENT", name: "小林" },
    });
    mockFindUnique.mockResolvedValue({ ...ACTIVE_USER, status: "SUSPENDED" });

    await expect(requireUser()).rejects.toThrow("REDIRECT:/login");
    expect(mockRedirect).toHaveBeenCalledWith("/login");
  });

  it("rejects the session when the account has been deleted", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", role: "STUDENT", name: "小林" },
    });
    mockFindUnique.mockResolvedValue({
      ...ACTIVE_USER,
      deletedAt: new Date("2026-01-01T00:00:00Z"),
    });

    await expect(requireUser()).rejects.toThrow("REDIRECT:/login");
    expect(mockRedirect).toHaveBeenCalledWith("/login");
  });

  it("redirects to the consent page when required policies are missing (consent gate)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", role: "STUDENT", name: "小林" },
    });
    mockFindUnique.mockResolvedValue({ ...ACTIVE_USER });
    mockGetUserAcceptanceStatus.mockResolvedValue({
      compliant: false,
      required: [{ id: "doc-2", type: "TERMS_OF_SERVICE", version: 2 }],
      pending: [{ id: "doc-2", type: "TERMS_OF_SERVICE", version: 2, state: "OUTDATED" }],
    });

    await expect(requireUser()).rejects.toThrow("REDIRECT:/legal/accept");
    expect(mockRedirect).toHaveBeenCalledWith("/legal/accept");
  });

  it("does not reach the consent check when the account is inactive", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", role: "STUDENT", name: "小林" },
    });
    mockFindUnique.mockResolvedValue({ ...ACTIVE_USER, erasedAt: new Date() });

    await expect(requireUser()).rejects.toThrow("REDIRECT:/login");
    expect(mockGetUserAcceptanceStatus).not.toHaveBeenCalled();
  });
});

describe("requireAdmin（Phase 6A 兼容桥：full-admin 等价判定）", () => {
  const ADMIN_BASE = {
    ...ACTIVE_USER,
    id: "admin-1",
    role: "ADMIN" as const,
    name: "管理员",
  };

  // full-admin 等价：GLOBAL grant 完整覆盖 legacy admin surface
  const FULL_ADMIN_GRANT = {
    campusId: null,
    role: {
      key: "PLATFORM_ADMIN",
      scope: "GLOBAL",
      rolePermissions: ADMIN_SURFACE_PERMISSION_KEYS.map((key) => ({ permission: { key } })),
    },
  };

  const ADMIN_WITH_GRANT = {
    ...ADMIN_BASE,
    memberships: [],
    userRoles: [FULL_ADMIN_GRANT],
  };

  it("redirects home when the user holds no admin permission", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", role: "STUDENT" },
    });
    mockFindUnique.mockResolvedValue({
      ...ACTIVE_USER,
      name: "普通学生",
      memberships: [],
      userRoles: [],
    });

    await expect(requireAdmin()).rejects.toThrow("REDIRECT:/");
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("denies legacy role=ADMIN without a UserRoleAssignment（单一授权来源锁定）", async () => {
    // User.role 字段不再是授权依据：migration/seed 未同步授予角色时必须拒绝
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN" },
    });
    mockFindUnique.mockResolvedValue({
      ...ADMIN_BASE,
      memberships: [],
      userRoles: [],
    });

    await expect(requireAdmin()).rejects.toThrow("REDIRECT:/");
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("denies a limited GLOBAL role（仅 report.review ≠ legacy 超管，Repair 1 #25）", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "limited-1", role: "STUDENT" },
    });
    mockFindUnique.mockResolvedValue({
      ...ACTIVE_USER,
      id: "limited-1",
      name: "举报处理员",
      memberships: [],
      userRoles: [
        {
          campusId: null,
          role: {
            key: "GLOBAL_REPORT_REVIEWER",
            scope: "GLOBAL",
            rolePermissions: [{ permission: { key: "report.review" } }],
          },
        },
      ],
    });

    await expect(requireAdmin()).rejects.toThrow("REDIRECT:/");
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("denies stitched campus-scoped grants even when the union covers the full set", async () => {
    const keys = ADMIN_SURFACE_PERMISSION_KEYS;
    const half = Math.ceil(keys.length / 2);
    mockAuth.mockResolvedValue({
      user: { id: "stitched-1", role: "STUDENT" },
    });
    mockFindUnique.mockResolvedValue({
      ...ACTIVE_USER,
      id: "stitched-1",
      memberships: [],
      userRoles: [
        {
          campusId: "campus-a",
          role: {
            key: "CAMPUS_A_HALF",
            scope: "CAMPUS",
            rolePermissions: keys.slice(0, half).map((key) => ({ permission: { key } })),
          },
        },
        {
          campusId: "campus-b",
          role: {
            key: "CAMPUS_B_HALF",
            scope: "CAMPUS",
            rolePermissions: keys.slice(half).map((key) => ({ permission: { key } })),
          },
        },
      ],
    });

    await expect(requireAdmin()).rejects.toThrow("REDIRECT:/");
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("returns the admin user when a PLATFORM_ADMIN grant exists", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", name: "管理员" },
    });
    mockFindUnique.mockResolvedValue({ ...ADMIN_WITH_GRANT });

    await expect(requireAdmin()).resolves.toEqual({ ...ADMIN_WITH_GRANT });
  });
});

describe("getVerifiedSession（API 路由会话校验）", () => {
  it("returns UNAUTHENTICATED without session", async () => {
    mockAuth.mockResolvedValue(null);

    await expect(getVerifiedSession({ requireConsent: true })).resolves.toEqual({
      ok: false,
      reason: "UNAUTHENTICATED",
    });
  });

  it("returns ACCOUNT_INACTIVE for erased accounts", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockFindUnique.mockResolvedValue({ ...ACTIVE_USER, erasedAt: new Date() });

    await expect(getVerifiedSession({ requireConsent: false })).resolves.toEqual({
      ok: false,
      reason: "ACCOUNT_INACTIVE",
    });
  });

  it("returns LEGAL_ACCEPTANCE_REQUIRED for gated mutations when policies are pending", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockFindUnique.mockResolvedValue({ ...ACTIVE_USER });
    mockGetUserAcceptanceStatus.mockResolvedValue({ compliant: false, required: [], pending: [] });

    const gated = await getVerifiedSession({ requireConsent: true });
    expect(gated).toEqual({ ok: false, reason: "LEGAL_ACCEPTANCE_REQUIRED" });

    // 隐私自助操作不要求 consent（退出权优先）
    const ungated = await getVerifiedSession({ requireConsent: false });
    expect(ungated).toEqual({
      ok: true,
      user: { id: "user-1", email: "lin@example.com", name: "小林", role: "STUDENT" },
    });
  });
});
