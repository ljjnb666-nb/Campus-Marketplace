import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, loadAuthorizationContext, hasPermission, notFound } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  hasPermission: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/rbac/service", () => ({ loadAuthorizationContext, hasPermission }));
vi.mock("next/navigation", () => ({ notFound }));

import type { AuthorizationContext } from "@/lib/rbac/service";
import {
  deriveOperationsOverviewAccess,
  hasAnyOperationsOverviewAccess,
  requireOperationsOverviewAdmin,
} from "@/lib/governance/operations-overview-access";

/** 与中央 hasPermission GLOBAL-only 语义同构的最小 mock（不传 campusId → 仅 GLOBAL）。 */
function useCentralHasPermission() {
  hasPermission.mockImplementation(
    (
      context: {
        accountActive?: boolean;
        grants?: Array<{ scope: string; permissionKeys: string[] }>;
      } | null,
      permission: string,
    ) =>
      Boolean(
        context?.accountActive &&
          context.grants?.some(
            (grant) => grant.scope === "GLOBAL" && grant.permissionKeys.includes(permission),
          ),
      ),
  );
}

const activeContext: AuthorizationContext = {
  userId: "op-1",
  accountActive: true,
  activeCampusIds: [] as string[],
  grants: [],
};

beforeEach(() => {
  requireUser.mockReset();
  loadAuthorizationContext.mockReset();
  hasPermission.mockReset();
  notFound.mockClear();
  useCentralHasPermission();
});

describe("deriveOperationsOverviewAccess（GLOBAL only，SO01/SO02/SO03 派生层）", () => {
  it("SO01：GLOBAL operations.overview grant → global=true", () => {
    const access = deriveOperationsOverviewAccess({
      ...activeContext,
      grants: [
        { roleKey: "OP", scope: "GLOBAL", campusId: null, permissionKeys: ["operations.overview"] },
      ],
    });
    expect(access).toEqual({ global: true });
    expect(hasAnyOperationsOverviewAccess(access)).toBe(true);
  });

  it("SO02：CAMPUS operations.overview grant（即使误配存在）→ global=false（GLOBAL ONLY DENY）", () => {
    const access = deriveOperationsOverviewAccess({
      ...activeContext,
      activeCampusIds: ["A"],
      grants: [
        { roleKey: "BAD", scope: "CAMPUS", campusId: "A", permissionKeys: ["operations.overview"] },
      ],
    });
    expect(access).toEqual({ global: false });
    expect(hasAnyOperationsOverviewAccess(access)).toBe(false);
  });

  it("SO03：零 grant / 停用账号 / null context → global=false（fail-closed）", () => {
    expect(deriveOperationsOverviewAccess(activeContext)).toEqual({ global: false });
    expect(
      deriveOperationsOverviewAccess({
        ...activeContext,
        accountActive: false,
        grants: [
          { roleKey: "OP", scope: "GLOBAL", campusId: null, permissionKeys: ["operations.overview"] },
        ],
      }),
    ).toEqual({ global: false });
    expect(deriveOperationsOverviewAccess(null)).toEqual({ global: false });
  });
});

describe("requireOperationsOverviewAdmin（/governance/system 子树自守门）", () => {
  it("GLOBAL operations.overview → 返回 session，不 notFound", async () => {
    requireUser.mockResolvedValue({ id: "op-1", email: "op@x", name: "OP" });
    loadAuthorizationContext.mockResolvedValue({
      ...activeContext,
      grants: [
        { roleKey: "OP", scope: "GLOBAL", campusId: null, permissionKeys: ["operations.overview"] },
      ],
    });

    const session = await requireOperationsOverviewAdmin();

    expect(session.user.id).toBe("op-1");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("无 permission → notFound（不泄露治理面存在性）", async () => {
    requireUser.mockResolvedValue({ id: "u-1", email: "u@x", name: "U" });
    loadAuthorizationContext.mockResolvedValue(activeContext);

    await expect(requireOperationsOverviewAdmin()).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });
});
