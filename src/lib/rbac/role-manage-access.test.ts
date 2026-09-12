import { describe, expect, it } from "vitest";

import {
  MANAGEABLE_GOVERNANCE_ROLE_KEYS,
  canManageCampus,
  deriveRoleManageAccess,
  hasAnyRoleManageAccess,
  isManageableGovernanceRoleKey,
} from "@/lib/rbac/role-manage-access";
import { CAMPUS_APPEAL_REVIEWER_ROLE_KEY } from "@/lib/rbac/roles";
import type { AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7B 冻结矩阵 U01..U08：role-manage access SSOT。
 * 语义必须与 hasPermission / deriveAppealReviewAccess 逐条同构（DEFAULT_DENY）。
 */

function context(overrides: Partial<AuthorizationContext>): AuthorizationContext {
  return {
    userId: "user-1",
    accountActive: true,
    activeCampusIds: [],
    grants: [],
    ...overrides,
  };
}

// U01：allowlist 显式冻结，禁止派生扩列
describe("MANAGEABLE_GOVERNANCE_ROLE_KEYS（U01）", () => {
  it("v1 恰为 [CAMPUS_APPEAL_REVIEWER]，且 isManageableGovernanceRoleKey 收窄判定", () => {
    expect([...MANAGEABLE_GOVERNANCE_ROLE_KEYS]).toEqual([
      CAMPUS_APPEAL_REVIEWER_ROLE_KEY,
    ]);
    expect(isManageableGovernanceRoleKey("CAMPUS_APPEAL_REVIEWER")).toBe(true);
    expect(isManageableGovernanceRoleKey("PLATFORM_ADMIN")).toBe(false);
    expect(isManageableGovernanceRoleKey("FUTURE_CAMPUS_ROLE")).toBe(false);
    expect(isManageableGovernanceRoleKey("")).toBe(false);
  });
});

// U02..U07：deriveRoleManageAccess 分支
describe("deriveRoleManageAccess（U02..U07）", () => {
  it("U02：GLOBAL rbac.role.assign → global=true，不要求 membership", () => {
    const access = deriveRoleManageAccess(
      context({
        grants: [
          {
            roleKey: "PLATFORM_ADMIN",
            scope: "GLOBAL",
            campusId: null,
            permissionKeys: ["rbac.role.assign"],
          },
        ],
      }),
    );
    expect(access).toEqual({ global: true, campusIds: [] });
  });

  it("U03：CAMPUS grant@A 仅在 membership@A ACTIVE 时进入 campusIds", () => {
    const grant = {
      roleKey: "CAMPUS_MANAGER",
      scope: "CAMPUS" as const,
      campusId: "campus-a",
      permissionKeys: ["rbac.role.assign"],
    };
    expect(
      deriveRoleManageAccess(
        context({ grants: [grant], activeCampusIds: ["campus-a"] }),
      ),
    ).toEqual({ global: false, campusIds: ["campus-a"] });
    // grant 在而 membership 不在 → 不进入
    expect(deriveRoleManageAccess(context({ grants: [grant] })).campusIds).toEqual(
      [],
    );
  });

  it("U04：非激活账号 → 空 access（DEFAULT_DENY）", () => {
    const access = deriveRoleManageAccess(
      context({
        accountActive: false,
        grants: [
          {
            roleKey: "PLATFORM_ADMIN",
            scope: "GLOBAL",
            campusId: null,
            permissionKeys: ["rbac.role.assign"],
          },
        ],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: [] });
  });

  it("U05：null context → 空 access", () => {
    expect(deriveRoleManageAccess(null)).toEqual({ global: false, campusIds: [] });
  });

  it("U06：同校区去重；多校区共存", () => {
    const grant = (campusId: string) => ({
      roleKey: "CAMPUS_MANAGER",
      scope: "CAMPUS" as const,
      campusId,
      permissionKeys: ["rbac.role.assign"],
    });
    const dedup = deriveRoleManageAccess(
      context({
        grants: [grant("campus-a"), grant("campus-a")],
        activeCampusIds: ["campus-a", "campus-b"],
      }),
    );
    expect(dedup.campusIds).toEqual(["campus-a"]);
    const multi = deriveRoleManageAccess(
      context({
        grants: [grant("campus-a"), grant("campus-b")],
        activeCampusIds: ["campus-a", "campus-b"],
      }),
    );
    expect(multi.campusIds).toEqual(["campus-a", "campus-b"]);
  });

  it("U07：无 rbac.role.assign 的 grant（如 GLOBAL appeal.review）不产生 access；绝不读 User.role", () => {
    const access = deriveRoleManageAccess(
      context({
        grants: [
          {
            roleKey: "CAMPUS_APPEAL_REVIEWER",
            scope: "GLOBAL",
            campusId: null,
            permissionKeys: ["appeal.review"],
          },
        ],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: [] });
  });
});

// U08：canManageCampus / hasAnyRoleManageAccess 真值表
describe("canManageCampus / hasAnyRoleManageAccess（U08）", () => {
  const globalAccess = { global: true, campusIds: [] };
  const campusAccess = { global: false, campusIds: ["campus-a"] };
  const emptyAccess = { global: false, campusIds: [] };

  it("canManageCampus：global 全通；campus 仅命中成员；空全拒", () => {
    expect(canManageCampus(globalAccess, "any-campus")).toBe(true);
    expect(canManageCampus(campusAccess, "campus-a")).toBe(true);
    expect(canManageCampus(campusAccess, "campus-b")).toBe(false);
    expect(canManageCampus(emptyAccess, "campus-a")).toBe(false);
  });

  it("hasAnyRoleManageAccess：union gate 分量", () => {
    expect(hasAnyRoleManageAccess(globalAccess)).toBe(true);
    expect(hasAnyRoleManageAccess(campusAccess)).toBe(true);
    expect(hasAnyRoleManageAccess(emptyAccess)).toBe(false);
  });
});
