import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireAdmin, requireUser } from "@/lib/server-auth";

const { mockAuth, mockRedirect, mockFindUnique } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRedirect: vi.fn(),
  mockFindUnique: vi.fn(),
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

beforeEach(() => {
  mockAuth.mockReset();
  mockRedirect.mockReset();
  mockFindUnique.mockReset();
  mockRedirect.mockImplementation((target: string) => {
    throw new Error(`REDIRECT:${target}`);
  });
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
    mockFindUnique.mockResolvedValue({
      id: "user-1",
      role: "STUDENT",
      name: "小林",
      email: "lin@example.com",
      avatarUrl: null,
      verificationStatus: "VERIFIED",
    });

    await expect(requireUser()).resolves.toEqual({
      id: "user-1",
      role: "STUDENT",
      name: "小林",
      email: "lin@example.com",
      avatarUrl: null,
      verificationStatus: "VERIFIED",
    });
  });
});

describe("requireAdmin", () => {
  it("redirects home when the user is not an admin", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", role: "STUDENT" },
    });
    mockFindUnique.mockResolvedValue({
      id: "user-1",
      role: "STUDENT",
      name: "普通学生",
    });

    await expect(requireAdmin()).rejects.toThrow("REDIRECT:/");
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("returns the admin user", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", name: "管理员" },
    });
    mockFindUnique.mockResolvedValue({
      id: "admin-1",
      role: "ADMIN",
      name: "管理员",
    });

    await expect(requireAdmin()).resolves.toEqual({
      id: "admin-1",
      role: "ADMIN",
      name: "管理员",
    });
  });
});
