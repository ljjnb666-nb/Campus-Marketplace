import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

/**
 * Phase 8A-03（P8-B03）：block/unblock 领域事务单元测试。
 *
 * 冻结合同：
 *   - 锁域 = sorted USER participant pair（经 acquireGovernanceSubjectLocks
 *     统一排序；禁止 actor-first 手工顺序）
 *   - 完整锁集持有后 assertActiveAccountMutationAllowed(actor)（不得经
 *     prepareActiveAccountMutation 以错误顺序重取 actor-only 锁）
 *   - seam 语义保持：beforeLock → locks → active check → afterCheck → write
 *   - BlockedUser 行保持 directional：仅写 blocker→blocked 单行，绝不创建
 *     镜像行（effective pair block 是读取时派生，见 communication-policy）
 */

const { acquireGovernanceSubjectLocks, assertActiveAccountMutationAllowed } = vi.hoisted(() => ({
  acquireGovernanceSubjectLocks: vi.fn(),
  assertActiveAccountMutationAllowed: vi.fn(),
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLocks,
}));

vi.mock("@/lib/governance/active-account-mutation", () => ({
  assertActiveAccountMutationAllowed,
  // 若 block-service 误用 prepareActiveAccountMutation（actor-only 先锁），
  // 本 mock 缺失导出会直接暴露
}));

const { blockedUserUpsert, blockedUserDeleteMany } = vi.hoisted(() => ({
  blockedUserUpsert: vi.fn(),
  blockedUserDeleteMany: vi.fn(),
}));

function makeTx(): Prisma.TransactionClient {
  return {
    blockedUser: {
      upsert: blockedUserUpsert,
      deleteMany: blockedUserDeleteMany,
    },
  } as unknown as Prisma.TransactionClient;
}

import { blockUserTx, unblockUserTx } from "@/lib/trust/block-service";

describe("block-service（8A-03 pair lock contract）", () => {
  beforeEach(() => {
    acquireGovernanceSubjectLocks.mockReset().mockResolvedValue(undefined);
    assertActiveAccountMutationAllowed.mockReset().mockResolvedValue(undefined);
    blockedUserUpsert.mockReset().mockResolvedValue({});
    blockedUserDeleteMany.mockReset().mockResolvedValue({ count: 1 });
  });

  describe("blockUserTx", () => {
    it("locks the sorted participant USER pair via acquireGovernanceSubjectLocks", async () => {
      await blockUserTx(makeTx(), "user-a", { targetUserId: "user-b", reason: "骚扰" });

      expect(acquireGovernanceSubjectLocks).toHaveBeenCalledTimes(1);
      expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(expect.anything(), [
        { subjectType: "USER", subjectId: "user-a" },
        { subjectType: "USER", subjectId: "user-b" },
      ]);
    });

    it("runs the fresh active-account check after locks（不重取 actor-only 锁）", async () => {
      await blockUserTx(makeTx(), "user-a", { targetUserId: "user-b", reason: "骚扰" });

      expect(assertActiveAccountMutationAllowed).toHaveBeenCalledTimes(1);
      expect(assertActiveAccountMutationAllowed).toHaveBeenCalledWith(expect.anything(), "user-a");
    });

    it("writes exactly one directional row（blocker→blocked，无镜像行）", async () => {
      await blockUserTx(makeTx(), "user-a", { targetUserId: "user-b", reason: "虚假交易" });

      expect(blockedUserUpsert).toHaveBeenCalledTimes(1);
      expect(blockedUserUpsert).toHaveBeenCalledWith({
        where: {
          blockerId_blockedUserId: { blockerId: "user-a", blockedUserId: "user-b" },
        },
        create: { blockerId: "user-a", blockedUserId: "user-b", reason: "虚假交易" },
        update: { reason: "虚假交易" },
      });
    });

    it("preserves seam order：beforeLock → locks → active check → afterCheck → write", async () => {
      const calls: string[] = [];
      acquireGovernanceSubjectLocks.mockImplementation(async () => {
        calls.push("locks");
      });
      assertActiveAccountMutationAllowed.mockImplementation(async () => {
        calls.push("activeCheck");
      });
      blockedUserUpsert.mockImplementation(async () => {
        calls.push("write");
      });

      await blockUserTx(
        makeTx(),
        "user-a",
        { targetUserId: "user-b", reason: "骚扰" },
        {
          beforeLock: async () => {
            calls.push("beforeLock");
          },
          afterCheck: async () => {
            calls.push("afterCheck");
          },
        },
      );

      expect(calls).toEqual(["beforeLock", "locks", "activeCheck", "afterCheck", "write"]);
    });

    it("denies with zero writes when the actor is inactive（RB-03 fail closed）", async () => {
      assertActiveAccountMutationAllowed.mockRejectedValue(
        Object.assign(new Error("账号当前不可用"), { code: "AUTH_ACCOUNT_INACTIVE" }),
      );

      await expect(
        blockUserTx(makeTx(), "user-a", { targetUserId: "user-b", reason: "骚扰" }),
      ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

      expect(blockedUserUpsert).not.toHaveBeenCalled();
    });
  });

  describe("unblockUserTx", () => {
    it("locks the sorted participant USER pair and deletes only the actor→target row", async () => {
      await unblockUserTx(makeTx(), "user-b", "user-a");

      expect(acquireGovernanceSubjectLocks).toHaveBeenCalledTimes(1);
      expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(expect.anything(), [
        { subjectType: "USER", subjectId: "user-b" },
        { subjectType: "USER", subjectId: "user-a" },
      ]);
      expect(assertActiveAccountMutationAllowed).toHaveBeenCalledWith(expect.anything(), "user-b");
      expect(blockedUserDeleteMany).toHaveBeenCalledWith({
        where: { blockerId: "user-b", blockedUserId: "user-a" },
      });
    });

    it("preserves seam order for race harnesses", async () => {
      const calls: string[] = [];
      acquireGovernanceSubjectLocks.mockImplementation(async () => {
        calls.push("locks");
      });
      blockedUserDeleteMany.mockImplementation(async () => {
        calls.push("write");
      });

      await unblockUserTx(
        makeTx(),
        "user-a",
        "user-b",
        {
          beforeLock: async () => {
            calls.push("beforeLock");
          },
          afterCheck: async () => {
            calls.push("afterCheck");
          },
        },
      );

      expect(calls).toEqual(["beforeLock", "locks", "afterCheck", "write"]);
    });
  });
});
