import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { acquireGovernanceSubjectLocks, loadAuthorizationContext, callOrder } = vi.hoisted(() => ({
  acquireGovernanceSubjectLocks: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  callOrder: [] as string[],
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLocks,
}));

// 只替换 loadAuthorizationContext（DB 读）；requirePermissionInContext /
// hasPermission 保持生产实现——permission 判定语义本身就是被测对象之一。
vi.mock("@/lib/rbac/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac/service")>();
  return {
    ...actual,
    loadAuthorizationContext: (...args: unknown[]) => {
      callOrder.push("loadAuthorizationContext");
      return loadAuthorizationContext(...(args as [string, Prisma.TransactionClient]));
    },
  };
});

import { prepareGovernanceMutationAuthority } from "@/lib/governance/governance-mutation-authority";
import { rbacError } from "@/lib/rbac/errors";
import type { AuthorizationContext } from "@/lib/rbac/service";

const tx = {} as Prisma.TransactionClient;

function contextWith(
  overrides: Partial<AuthorizationContext> & { grants: AuthorizationContext["grants"] },
): AuthorizationContext {
  return {
    userId: "actor-1",
    accountActive: true,
    activeCampusIds: [],
    ...overrides,
  };
}

describe("prepareGovernanceMutationAuthority (RB-05)", () => {
  beforeEach(() => {
    callOrder.length = 0;
    acquireGovernanceSubjectLocks.mockReset().mockImplementation(async () => {
      callOrder.push("acquireGovernanceSubjectLocks");
    });
    loadAuthorizationContext.mockReset();
  });

  it("freezes the order: beforeLock → USER actor lock → fresh context → permission → afterCheck", async () => {
    loadAuthorizationContext.mockResolvedValue(
      contextWith({ grants: [{ roleKey: "PLATFORM_ADMIN", scope: "GLOBAL", campusId: null, permissionKeys: ["category.manage"] }] }),
    );

    const result = await prepareGovernanceMutationAuthority(tx, "actor-1", "category.manage", {
      beforeLock: async () => {
        callOrder.push("beforeLock");
      },
      afterCheck: async () => {
        callOrder.push("afterCheck");
      },
    });

    expect(callOrder).toEqual([
      "beforeLock",
      "acquireGovernanceSubjectLocks",
      "loadAuthorizationContext",
      "afterCheck",
    ]);
    // 锁是 USER actor subject 锁（与 revokeRole 的 sorted 锁域同键）
    expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(tx, [
      { subjectType: "USER", subjectId: "actor-1" },
    ]);
    // fresh 复核在锁内、同一 tx 上
    expect(loadAuthorizationContext).toHaveBeenCalledWith("actor-1", tx);
    // 返回锁内 fresh context（非入口快照）
    expect(result.userId).toBe("actor-1");
  });

  it("seals the lock before the fresh check（锁先于授权读，不许先查后锁）", async () => {
    loadAuthorizationContext.mockResolvedValue(
      contextWith({ grants: [{ roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["moderation.keyword.manage"] }] }),
    );

    await prepareGovernanceMutationAuthority(tx, "actor-1", "moderation.keyword.manage");

    const lockAt = callOrder.indexOf("acquireGovernanceSubjectLocks");
    const loadAt = callOrder.indexOf("loadAuthorizationContext");
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(loadAt);
  });

  it("denies a category actor holding only moderation.keyword.manage（exact permission isolation）", async () => {
    loadAuthorizationContext.mockResolvedValue(
      contextWith({ grants: [{ roleKey: "KEYWORD_ONLY", scope: "GLOBAL", campusId: null, permissionKeys: ["moderation.keyword.manage"] }] }),
    );

    await expect(
      prepareGovernanceMutationAuthority(tx, "actor-1", "category.manage"),
    ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });
  });

  it("allows a category actor holding category.manage", async () => {
    loadAuthorizationContext.mockResolvedValue(
      contextWith({ grants: [{ roleKey: "CATEGORY_ONLY", scope: "GLOBAL", campusId: null, permissionKeys: ["category.manage"] }] }),
    );

    await expect(
      prepareGovernanceMutationAuthority(tx, "actor-1", "category.manage"),
    ).resolves.toMatchObject({ userId: "actor-1" });
  });

  it("denies a keyword actor holding only category.manage", async () => {
    loadAuthorizationContext.mockResolvedValue(
      contextWith({ grants: [{ roleKey: "CATEGORY_ONLY", scope: "GLOBAL", campusId: null, permissionKeys: ["category.manage"] }] }),
    );

    await expect(
      prepareGovernanceMutationAuthority(tx, "actor-1", "moderation.keyword.manage"),
    ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });
  });

  it("denies an actor with no matching permission（DEFAULT_DENY / 未知 permission）", async () => {
    loadAuthorizationContext.mockResolvedValue(
      contextWith({ grants: [{ roleKey: "STUDENT", scope: "CAMPUS", campusId: "c1", permissionKeys: ["product.create"] }] }),
    );

    await expect(
      prepareGovernanceMutationAuthority(tx, "actor-1", "category.manage"),
    ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });
  });

  it("denies an inactive actor even with the exact permission", async () => {
    loadAuthorizationContext.mockResolvedValue(
      contextWith({
        accountActive: false,
        grants: [{ roleKey: "PLATFORM_ADMIN", scope: "GLOBAL", campusId: null, permissionKeys: ["category.manage", "moderation.keyword.manage"] }],
      }),
    );

    await expect(
      prepareGovernanceMutationAuthority(tx, "actor-1", "category.manage"),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });
  });

  it("denies a missing actor context（用户不存在）", async () => {
    loadAuthorizationContext.mockResolvedValue(null);

    await expect(
      prepareGovernanceMutationAuthority(tx, "ghost", "category.manage"),
    ).rejects.toMatchObject(rbacError("AUTH_PERMISSION_DENIED"));
  });

  it("never runs afterCheck when the fresh check fails", async () => {
    loadAuthorizationContext.mockResolvedValue(null);

    const afterCheck = vi.fn();
    await expect(
      prepareGovernanceMutationAuthority(tx, "actor-1", "category.manage", { afterCheck }),
    ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });
    expect(afterCheck).not.toHaveBeenCalled();
  });
});
