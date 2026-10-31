import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 合成测试凭据（拼接生成，非真实账号）
const TEST_PASSWORD = ["Student", "123456"].join("");


const {
  compare,
  getServerSession,
  credentialsProvider,
  userFindUnique,
  userUpdate,
  finalizeCredentialLogin,
  isAccountSessionActive,
} = vi.hoisted(() => ({
  compare: vi.fn(),
  getServerSession: vi.fn(),
  credentialsProvider: vi.fn((config: unknown) => config),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  finalizeCredentialLogin: vi.fn(),
  isAccountSessionActive: vi.fn(),
}));

// RB-03 REVIEW FIX：post-bcrypt authoritative finalization 边界
vi.mock("@/lib/credential-login-service", () => ({
  finalizeCredentialLogin,
}));
vi.mock("@/lib/account-session-service", () => ({
  describeDevice: () => "未知设备 · 浏览器",
  isAccountSessionActive,
  revokeSignedOutSession: vi.fn(),
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
import { loginRateLimitKeys } from "@/lib/login-rate-limit";

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
  credentialRecoveryRequired: false,
};

function mockValidCredentials() {
  userFindUnique.mockResolvedValue(ACTIVE_USER);
  compare.mockResolvedValue(true);
}

describe("auth options", () => {
  beforeEach(() => {
    compare.mockReset();
    getServerSession.mockReset();
    isAccountSessionActive.mockReset().mockResolvedValue(true);
    credentialsProvider.mockClear();
    userFindUnique.mockReset();
    userUpdate.mockReset();
    // 默认 finalizer：fresh identity（avatarUrl undefined 使旧 toEqual 兼容）
    finalizeCredentialLogin.mockReset();
    finalizeCredentialLogin.mockImplementation(
      async (candidate: { id: string; email: string }) => ({
        id: candidate.id,
        email: candidate.email,
        name: "测试同学",
        avatarUrl: undefined,
        role: "STUDENT" as const,
      }),
    );
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

  it("AUTH-2: SUSPENDED credentials establish an identity session", async () => {
    const authorize = getCredentialsAuthorize();
    userFindUnique.mockResolvedValue({
      ...ACTIVE_USER,
      status: "SUSPENDED",
    });
    compare.mockResolvedValue(true);

    const result = await authorize?.({
      email: "student1@campus.local",
      password: TEST_PASSWORD,
    });

    // 身份认证成功；业务权限恢复与否由 server-auth 中央 resolver 决定
    expect(compare).toHaveBeenCalledWith(TEST_PASSWORD, "hashed-password");
    expect(result).toEqual({
      id: "user-1",
      email: "student1@campus.local",
      name: "测试同学",
      role: "STUDENT",
    });
  });

  it("AUTH-4: erased user credentials are denied", async () => {
    const authorize = getCredentialsAuthorize();
    userFindUnique.mockResolvedValue({
      ...ACTIVE_USER,
      erasedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await authorize?.({
      email: "student1@campus.local",
      password: TEST_PASSWORD,
    });

    expect(result).toBeNull();
    expect(compare).not.toHaveBeenCalled();
  });

  it("AUTH-5: deleted (soft-removed) user credentials are denied", async () => {
    const authorize = getCredentialsAuthorize();
    userFindUnique.mockResolvedValue({
      ...ACTIVE_USER,
      deletedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await authorize?.({
      email: "student1@campus.local",
      password: TEST_PASSWORD,
    });

    expect(result).toBeNull();
    expect(compare).not.toHaveBeenCalled();
  });

  it("AUTH-6: missing user credentials are denied", async () => {
    const authorize = getCredentialsAuthorize();
    userFindUnique.mockResolvedValue(null);
    compare.mockResolvedValue(true);

    const result = await authorize?.({
      email: "ghost@campus.local",
      password: TEST_PASSWORD,
    });

    expect(result).toBeNull();
    expect(compare).not.toHaveBeenCalled();
  });

  it("rejects users whose status is neither ACTIVE nor SUSPENDED", async () => {
    const authorize = getCredentialsAuthorize();
    userFindUnique.mockResolvedValue({
      ...ACTIVE_USER,
      status: "SOME_FUTURE_STATUS",
    });

    const result = await authorize?.({
      email: "student1@campus.local",
      password: TEST_PASSWORD,
    });

    expect(result).toBeNull();
    expect(compare).not.toHaveBeenCalled();
  });

  it("RECOVERY-HOLD-04：恢复账号拒绝密码登录，且不消耗 bcrypt/新建会话", async () => {
    const authorize = getCredentialsAuthorize();
    userFindUnique.mockResolvedValue({ ...ACTIVE_USER, credentialRecoveryRequired: true });
    const result = await authorize?.({ email: ACTIVE_USER.email, password: TEST_PASSWORD });
    expect(result).toBeNull();
    expect(compare).not.toHaveBeenCalled();
    expect(finalizeCredentialLogin).not.toHaveBeenCalled();
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
      password: TEST_PASSWORD,
    });

    expect(compare).toHaveBeenCalledWith(TEST_PASSWORD, "hashed-password");
    // RB-03：lastLoginAt 写入在 finalizer 内（USER 锁下），不再直写 prisma
    expect(userUpdate).not.toHaveBeenCalled();
    expect(finalizeCredentialLogin).toHaveBeenCalledWith({
      id: "user-1",
      passwordHash: "hashed-password",
      email: "student1@campus.local",
      deviceLabel: "未知设备 · 浏览器",
      mfaCode: undefined,
    });
    expect(result).toEqual({
      id: "user-1",
      email: "student1@campus.local",
      name: "测试同学",
      role: "STUDENT",
    });
  });

  it("LOGIN-08 wiring: bcrypt success routes through finalizeCredentialLogin", async () => {
    const authorize = getCredentialsAuthorize();
    mockValidCredentials();

    await authorize?.({
      email: "student1@campus.local",
      password: TEST_PASSWORD,
    });

    expect(finalizeCredentialLogin).toHaveBeenCalledTimes(1);
    expect(finalizeCredentialLogin).toHaveBeenCalledWith({
      id: "user-1",
      passwordHash: "hashed-password",
      email: "student1@campus.local",
      deviceLabel: "未知设备 · 浏览器",
      mfaCode: undefined,
    });
  });

  it("LOGIN-09 wiring: finalizer null → authorize null（不视为成功登录）", async () => {
    const authorize = getCredentialsAuthorize();
    mockValidCredentials();
    finalizeCredentialLogin.mockResolvedValue(null);

    const result = await authorize?.({
      email: "student1@campus.local",
      password: TEST_PASSWORD,
    });

    expect(result).toBeNull();
  });

  it("LOGIN-10 wiring: returned identity comes from the finalizer fresh result", async () => {
    const authorize = getCredentialsAuthorize();
    mockValidCredentials();
    finalizeCredentialLogin.mockResolvedValue({
      id: "user-1",
      email: "fresh@example.com",
      name: "锁内新名",
      avatarUrl: "http://x/fresh.webp",
      role: "ADMIN" as const,
    });

    const result = await authorize?.({
      email: "student1@campus.local",
      password: TEST_PASSWORD,
    });

    // 绝不返回 pre-bcrypt candidate snapshot
    expect(result).toEqual({
      id: "user-1",
      email: "fresh@example.com",
      name: "锁内新名",
      image: "http://x/fresh.webp",
      role: "ADMIN",
    });
  });

  it("passes authOptions to getServerSession", async () => {
    getServerSession.mockResolvedValue({ user: { id: "user-1" } });

    const result = await auth();

    expect(getServerSession).toHaveBeenCalledWith(authOptions);
    expect(result).toEqual({ user: { id: "user-1" } });
  });

  it("rejects a cryptographically valid JWT whose session has been revoked", async () => {
    getServerSession.mockResolvedValue({ user: { id: "user-1", sessionId: "revoked" } });
    isAccountSessionActive.mockResolvedValue(false);
    expect(await auth()).toBeNull();
    expect(isAccountSessionActive).toHaveBeenCalledWith("user-1", "revoked");
  });

  describe("login rate limiting", () => {
    const limitedEmail = "bruteforce@campus.local";
    const validPassword = TEST_PASSWORD;
    let consoleWarn: ReturnType<typeof vi.spyOn>;

    function attemptLogin(
      credentials: AuthorizeCredentials,
      req?: AuthorizeRequest,
    ) {
      return getCredentialsAuthorize()?.(credentials, req);
    }

    beforeEach(async () => {
      for (const email of [limitedEmail, undefined, "reset-success@campus.local", "window-expiry@campus.local"]) {
        for (const headers of [undefined, { "x-forwarded-for": "203.0.113.7" }]) {
          const keys = loginRateLimitKeys(email, headers);
          await resetRateLimit(keys.sourceKey);
          await resetRateLimit(keys.accountSourceKey);
        }
      }
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
        expect.stringContaining("登录限流触发"),
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
        expect.stringContaining("登录限流触发"),
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
          password: ["Wrong", "Password1"].join(""),
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
