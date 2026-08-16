import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


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
import { resetRateLimit } from "@/lib/rate-limit";

type AuthorizeCredentials = Record<string, string> | undefined;
type AuthorizeRequest = {
  headers?: Record<string, unknown>;
};

function getCredentialsAuthorize() {
  return (authOptions.providers?.[0] as {
    authorize?: (
      credentials: AuthorizeCredentials,
      req?: AuthorizeRequest,
    ) => Promise<unknown>;
  } | undefined)?.authorize;
}

const ACTIVE_USER = {
  id: "user-1",
  email: "student1@campus.local",
  name: "测试同学",
  role: "STUDENT",
  status: "ACTIVE",
  deletedAt: null,
  passwordHash: "hashed-password",
};

function mockValidCredentials() {
  userFindUnique.mockResolvedValue(ACTIVE_USER);
  compare.mockResolvedValue(true);
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

  describe("login rate limiting", () => {
    const limitedEmail = "bruteforce@campus.local";
    const validPassword = "Student123456";
    let consoleWarn: ReturnType<typeof vi.spyOn>;

    function attemptLogin(
      credentials: AuthorizeCredentials,
      req?: AuthorizeRequest,
    ) {
      return getCredentialsAuthorize()?.(credentials, req);
    }

    beforeEach(() => {
      resetRateLimit(`login:${limitedEmail}`);
      resetRateLimit("login:203.0.113.7");
      resetRateLimit("login:reset-success@campus.local");
      resetRateLimit("login:window-expiry@campus.local");
      consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleWarn.mockRestore();
      vi.useRealTimers();
    });

    it("allows the 10th attempt but blocks the 11th even with valid credentials", async () => {
      userFindUnique.mockResolvedValue(ACTIVE_USER);
      compare.mockResolvedValue(false);

      for (let i = 0; i < 10; i += 1) {
        const result = await attemptLogin({ email: limitedEmail, password: validPassword });
        expect(result).toBeNull();
      }

      expect(userFindUnique).toHaveBeenCalledTimes(10);

      // 第 11 次：凭据换成完全正确的也被拒绝，且不再查库
      compare.mockResolvedValue(true);
      const blocked = await attemptLogin({ email: limitedEmail, password: validPassword });

      expect(blocked).toBeNull();
      expect(userFindUnique).toHaveBeenCalledTimes(10);
      expect(userUpdate).not.toHaveBeenCalled();
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining("login:bruteforce@campus.local"),
      );
    });

    it("succeeds under the limit", async () => {
      mockValidCredentials();

      const result = await attemptLogin({
        email: "under-limit@campus.local",
        password: validPassword,
      });

      expect(result).toEqual({
        id: "user-1",
        email: "student1@campus.local",
        name: "测试同学",
        role: "STUDENT",
      });
      expect(consoleWarn).not.toHaveBeenCalled();
    });

    it("limits by ip fallback when no identifier is provided", async () => {
      const req = { headers: { "x-forwarded-for": "203.0.113.7, 198.51.100.9" } };
      const noCredentials = undefined;

      for (let i = 0; i < 10; i += 1) {
        await attemptLogin(noCredentials, req);
      }

      await attemptLogin(noCredentials, req);

      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining("login:203.0.113.7"),
      );
      expect(userFindUnique).not.toHaveBeenCalled();
    });

    it("allows logging in again after the window expires", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

      userFindUnique.mockResolvedValue(ACTIVE_USER);
      compare.mockResolvedValue(false);

      for (let i = 0; i < 10; i += 1) {
        await attemptLogin({
          email: "window-expiry@campus.local",
          password: validPassword,
        });
      }

      compare.mockResolvedValue(true);
      const blocked = await attemptLogin({
        email: "window-expiry@campus.local",
        password: validPassword,
      });
      expect(blocked).toBeNull();

      vi.setSystemTime(new Date("2026-01-01T00:15:01Z"));

      const allowed = await attemptLogin({
        email: "window-expiry@campus.local",
        password: validPassword,
      });

      expect(allowed).toEqual({
        id: "user-1",
        email: "student1@campus.local",
        name: "测试同学",
        role: "STUDENT",
      });
    });

    it("resets the counter for an identifier after a successful login", async () => {
      userFindUnique.mockResolvedValue(ACTIVE_USER);
      compare.mockResolvedValue(false);

      for (let i = 0; i < 9; i += 1) {
        await attemptLogin({
          email: "reset-success@campus.local",
          password: "WrongPassword1",
        });
      }

      compare.mockResolvedValue(true);
      const success = await attemptLogin({
        email: "reset-success@campus.local",
        password: validPassword,
      });
      expect(success).not.toBeNull();

      // 第 11 次请求：如果没有在成功后重置，这里会被限流
      const again = await attemptLogin({
        email: "reset-success@campus.local",
        password: validPassword,
      });

      expect(again).not.toBeNull();
      expect(consoleWarn).not.toHaveBeenCalled();
    });
  });
});
