import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  compare,
  getServerSession,
  credentialsProvider,
  userFindUnique,
  userUpdate,
} = vi.hoisted(() => ({
  compare: vi.fn(),
  getServerSession: vi.fn(),
  credentialsProvider: vi.fn((config: unknown) => config),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  compare,
}));

vi.mock("next-auth", () => ({
  getServerSession,
}));

vi.mock("next-auth/providers/credentials", () => ({
  default: credentialsProvider,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
      update: userUpdate,
    },
  },
}));

import { auth, authOptions } from "@/lib/auth";

function getCredentialsAuthorize() {
  return (authOptions.providers?.[0] as {
    authorize?: (credentials: Record<string, string>) => Promise<unknown>;
  } | undefined)?.authorize;
}

describe("auth options", () => {
  beforeEach(() => {
    compare.mockReset();
    getServerSession.mockReset();
    credentialsProvider.mockClear();
    userFindUnique.mockReset();
    userUpdate.mockReset();
  });

  it("rejects invalid credentials before querying the database", async () => {
    const authorize = getCredentialsAuthorize();

    const result = await authorize?.({
      email: "bad-email",
      password: "123",
    });

    expect(result).toBeNull();
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("rejects inactive or deleted users", async () => {
    const authorize = getCredentialsAuthorize();
    userFindUnique.mockResolvedValue({
      id: "user-1",
      email: "student1@campus.local",
      name: "测试同学",
      role: "STUDENT",
      status: "SUSPENDED",
      deletedAt: null,
      passwordHash: "hashed-password",
    });

    const result = await authorize?.({
      email: "student1@campus.local",
      password: "Student123456",
    });

    expect(result).toBeNull();
    expect(compare).not.toHaveBeenCalled();
  });

  it("returns the session user and updates last login time after a successful login", async () => {
    const authorize = getCredentialsAuthorize();
    userFindUnique.mockResolvedValue({
      id: "user-1",
      email: "student1@campus.local",
      name: "测试同学",
      role: "STUDENT",
      status: "ACTIVE",
      deletedAt: null,
      passwordHash: "hashed-password",
    });
    compare.mockResolvedValue(true);

    const result = await authorize?.({
      email: "student1@campus.local",
      password: "Student123456",
    });

    expect(compare).toHaveBeenCalledWith("Student123456", "hashed-password");
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { lastLoginAt: expect.any(Date) },
    });
    expect(result).toEqual({
      id: "user-1",
      email: "student1@campus.local",
      name: "测试同学",
      role: "STUDENT",
    });
  });

  it("passes authOptions to getServerSession", async () => {
    getServerSession.mockResolvedValue({ user: { id: "user-1" } });

    const result = await auth();

    expect(getServerSession).toHaveBeenCalledWith(authOptions);
    expect(result).toEqual({ user: { id: "user-1" } });
  });
});
