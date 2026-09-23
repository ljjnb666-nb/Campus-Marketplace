import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const { acquireGovernanceSubjectLock, withTransaction } = vi.hoisted(() => ({
  acquireGovernanceSubjectLock: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLock,
}));

vi.mock("@/lib/prisma", () => ({
  withTransaction,
}));

import { finalizeCredentialLogin } from "@/lib/credential-login-service";

/**
 * RB-03 REVIEW FIX：CREDENTIAL_LOGIN_FINALIZATION_CONTRACT 单元合同。
 *
 * bcrypt（在调用方/锁外）成功之后，finalizer 是唯一的 post-bcrypt
 * authoritative login boundary：USER 锁内 fresh lifecycle
 * （ACTIVE/SUSPENDED）/ passwordHash / email 三重复核 + lastLoginAt 写入，
 * identity 必须来自锁内 fresh 行。
 */

const FRESH_USER = {
  id: "user-1",
  email: "user-1@example.com",
  name: "张同学",
  avatarUrl: "http://x/a.webp",
  role: "STUDENT" as const,
  passwordHash: "$2a$10$verifiedhash",
  status: "ACTIVE" as const,
  deletedAt: null,
  erasedAt: null,
};

const CANDIDATE = {
  id: "user-1",
  passwordHash: "$2a$10$verifiedhash",
  email: "user-1@example.com",
};

function makeTx() {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue({ ...FRESH_USER }),
      update: vi.fn().mockResolvedValue({
        id: FRESH_USER.id,
        email: FRESH_USER.email,
        name: FRESH_USER.name,
        avatarUrl: FRESH_USER.avatarUrl,
        role: FRESH_USER.role,
      }),
    },
  } as unknown as Prisma.TransactionClient & {
    user: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  };
}

beforeEach(() => {
  acquireGovernanceSubjectLock.mockReset().mockResolvedValue(undefined);
  withTransaction.mockReset().mockImplementation(
    async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => callback(makeTx()),
  );
});

describe("finalizeCredentialLogin（RB-03 credential finalizer）", () => {
  it("LOGIN-01：ACTIVE + 凭据绑定一致 → finalize PASS（identity 来自锁内 fresh update 返回值）", async () => {
    const identity = await finalizeCredentialLogin(CANDIDATE);

    expect(identity).toEqual({
      id: "user-1",
      email: "user-1@example.com",
      name: "张同学",
      avatarUrl: "http://x/a.webp",
      role: "STUDENT",
    });
    expect(acquireGovernanceSubjectLock).toHaveBeenCalledWith(
      expect.anything(),
      "USER",
      "user-1",
    );
  });

  it("LOGIN-02：SUSPENDED → finalize PASS（身份会话语义，绝不改回 ACTIVE）", async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({ ...FRESH_USER, status: "SUSPENDED" });
    withTransaction.mockImplementation(async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(tx),
    );

    const identity = await finalizeCredentialLogin(CANDIDATE);

    expect(identity).not.toBeNull();
    // SUSPENDED 登录只写 lastLoginAt：绝不改变 status
    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastLoginAt: expect.any(Date) } }),
    );
  });

  it("LOGIN-03：erased → null（不写 lastLoginAt）", async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({
      ...FRESH_USER,
      erasedAt: new Date("2026-09-23T00:00:00Z"),
      passwordHash: "$2a$10$erasedrandomhash",
      status: "ACTIVE",
    });
    withTransaction.mockImplementation(async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(tx),
    );

    expect(await finalizeCredentialLogin(CANDIDATE)).toBeNull();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("LOGIN-04：deleted → null", async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({ ...FRESH_USER, deletedAt: new Date() });
    withTransaction.mockImplementation(async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(tx),
    );

    expect(await finalizeCredentialLogin(CANDIDATE)).toBeNull();
  });

  it("LOGIN-05：unsupported status → null", async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({ ...FRESH_USER, status: "BANNED_UNKNOWN" });
    withTransaction.mockImplementation(async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(tx),
    );

    expect(await finalizeCredentialLogin(CANDIDATE)).toBeNull();
  });

  it("LOGIN-06：fresh.passwordHash ≠ 已验证 candidate hash → null（lastLoginAt 不更新）", async () => {
    const tx = makeTx();
    // erasure/改密后 fresh hash 已变化；bcrypt 是对旧 hash 成功的
    tx.user.findUnique.mockResolvedValue({
      ...FRESH_USER,
      passwordHash: "$2a$10$differentnewhash",
    });
    withTransaction.mockImplementation(async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(tx),
    );

    expect(await finalizeCredentialLogin(CANDIDATE)).toBeNull();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("LOGIN-07：fresh.email ≠ candidate email → null", async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({ ...FRESH_USER, email: "renamed@example.com" });
    withTransaction.mockImplementation(async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(tx),
    );

    expect(await finalizeCredentialLogin(CANDIDATE)).toBeNull();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("LOGIN-06b：missing user（fresh = null）→ null", async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue(null);
    withTransaction.mockImplementation(async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(tx),
    );

    expect(await finalizeCredentialLogin(CANDIDATE)).toBeNull();
  });

  it("LOGIN-08 seam 顺序：beforeLock → 锁 → fresh 复核 → afterCheck → 写入", async () => {
    const tx = makeTx();
    withTransaction.mockImplementation(async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(tx),
    );
    const order: string[] = [];
    acquireGovernanceSubjectLock.mockImplementation(async () => {
      order.push("lock");
    });
    tx.user.findUnique.mockImplementation(async () => {
      order.push("freshRead");
      return { ...FRESH_USER };
    });

    await finalizeCredentialLogin(CANDIDATE, {
      beforeLock: async () => {
        order.push("beforeLock");
      },
      afterCheck: async () => {
        order.push("afterCheck");
      },
    });

    expect(order).toEqual(["beforeLock", "lock", "freshRead", "afterCheck"]);
  });

  it("LOGIN-09：withTransaction 自持完整事务边界（finalizer 不依赖调用方 tx）", async () => {
    const tx = makeTx();
    withTransaction.mockImplementation(async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(tx),
    );

    await finalizeCredentialLogin(CANDIDATE);

    expect(withTransaction).toHaveBeenCalledTimes(1);
  });
});
