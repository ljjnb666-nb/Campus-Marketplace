import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const { acquireGovernanceSubjectLocks, loadAuthorizationContext } = vi.hoisted(() => ({
  acquireGovernanceSubjectLocks: vi.fn(),
  loadAuthorizationContext: vi.fn(),
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLocks,
}));

vi.mock("@/lib/rbac/service", () => ({
  loadAuthorizationContext,
}));

import { prepareActiveAccountMutation } from "@/lib/governance/active-account-mutation";

/**
 * RB-03 ACTIVE_ACCOUNT_MUTATION_CONTRACT：guard 单元合同。
 * lifecycle 判定复用 canonical loadAuthorizationContext（accountActive），
 * 锁域与 eraseAccount 同一 USER governance subject lock。
 */

const tx = {} as unknown as Prisma.TransactionClient;

function activeContext() {
  return {
    userId: "user-1",
    accountActive: true,
    activeCampusIds: ["campus-a"],
    grants: [],
  };
}

beforeEach(() => {
  acquireGovernanceSubjectLocks.mockReset().mockResolvedValue(undefined);
  loadAuthorizationContext.mockReset();
});

describe("prepareActiveAccountMutation（RB-03 guard）", () => {
  it("active 账号 → 放行，且对同一 USER subject 取 governance 锁", async () => {
    loadAuthorizationContext.mockResolvedValue(activeContext());

    await expect(prepareActiveAccountMutation(tx, "user-1")).resolves.toBeUndefined();

    expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(tx, [
      { subjectType: "USER", subjectId: "user-1" },
    ]);
    // fresh check 在锁内、以 tx 执行（READ COMMITTED fresh read）
    expect(loadAuthorizationContext).toHaveBeenCalledWith("user-1", tx);
  });

  it("SUSPENDED → AUTH_ACCOUNT_INACTIVE（锁已取、零业务写入）", async () => {
    loadAuthorizationContext.mockResolvedValue({ ...activeContext(), accountActive: false });

    await expect(prepareActiveAccountMutation(tx, "user-1")).rejects.toMatchObject({
      code: "AUTH_ACCOUNT_INACTIVE",
    });
  });

  it("missing user（context = null）→ AUTH_ACCOUNT_INACTIVE", async () => {
    loadAuthorizationContext.mockResolvedValue(null);

    await expect(prepareActiveAccountMutation(tx, "ghost")).rejects.toMatchObject({
      code: "AUTH_ACCOUNT_INACTIVE",
    });
  });

  it("seams.beforeLock 在取锁前触发（RACE-01/03 stale 请求构造点）", async () => {
    loadAuthorizationContext.mockResolvedValue(activeContext());
    const order: string[] = [];
    acquireGovernanceSubjectLocks.mockImplementation(async () => {
      order.push("lock");
    });
    await prepareActiveAccountMutation(tx, "user-1", {
      beforeLock: async () => {
        order.push("beforeLock");
      },
    });

    expect(order).toEqual(["beforeLock", "lock"]);
  });

  it("seams.afterCheck 在 fresh check 后触发（RACE-02 持锁挂起点）", async () => {
    loadAuthorizationContext.mockResolvedValue(activeContext());
    const order: string[] = [];
    loadAuthorizationContext.mockImplementation(async () => {
      order.push("check");
      return activeContext();
    });
    await prepareActiveAccountMutation(tx, "user-1", {
      afterCheck: async () => {
        order.push("afterCheck");
      },
    });

    expect(order).toEqual(["check", "afterCheck"]);
  });

  it("beforeLock 阶段账号已失效 → 仍在锁内 fresh check 处 fail closed", async () => {
    loadAuthorizationContext.mockResolvedValue(null);

    await expect(
      prepareActiveAccountMutation(tx, "user-1", {
        beforeLock: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });
  });
});
