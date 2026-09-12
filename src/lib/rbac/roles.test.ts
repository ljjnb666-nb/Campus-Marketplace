import { describe, expect, it } from "vitest";

import { PERMISSION_KEYS } from "@/lib/rbac/permissions";
import {
  CAMPUS_APPEAL_REVIEWER_ROLE_KEY,
  GLOBAL_SCOPE_KEY,
  PLATFORM_ADMIN_ROLE_KEY,
  SYSTEM_ROLES,
  campusScopeKey,
} from "@/lib/rbac/roles";
import { hasFullAdminSurfaceAccess } from "@/lib/rbac/service";
import type { AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7A：SYSTEM_ROLES 定义合同（bootstrap 的唯一定义来源）。
 * Planning Repair 2 冻结：
 * - CAMPUS_APPEAL_REVIEWER：scope=CAMPUS，permission 恰为 ["appeal.review"]；
 * - PLATFORM_ADMIN 语义不变（GLOBAL 全量 permission）；
 * - 新 CAMPUS 角色不得扩大 legacy /admin 桥（hasFullAdminSurfaceAccess）。
 */

function contextWithGrant(
  grants: AuthorizationContext["grants"],
): AuthorizationContext {
  return { userId: "u", accountActive: true, activeCampusIds: [], grants };
}

describe("SYSTEM_ROLES：CAMPUS_APPEAL_REVIEWER 定义合同", () => {
  const reviewerRole = SYSTEM_ROLES.find(
    (role) => role.key === CAMPUS_APPEAL_REVIEWER_ROLE_KEY,
  );

  it("角色存在且 scope=CAMPUS", () => {
    expect(reviewerRole).toBeDefined();
    expect(reviewerRole!.scope).toBe("CAMPUS");
    expect(reviewerRole!.name).toBe("校区申诉审核员");
  });

  it("permission 恰为 [\"appeal.review\"]（无多无少）", () => {
    expect(reviewerRole!.permissionKeys).toEqual(["appeal.review"]);
  });

  it("PLATFORM_ADMIN 定义保持不变（GLOBAL 全量）", () => {
    const admin = SYSTEM_ROLES.find((role) => role.key === PLATFORM_ADMIN_ROLE_KEY);
    expect(admin).toBeDefined();
    expect(admin!.scope).toBe("GLOBAL");
    expect([...admin!.permissionKeys].sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  it("不引入新 permission key（appeal.review 为 6C-1B 既有 key）", () => {
    for (const role of SYSTEM_ROLES) {
      for (const key of role.permissionKeys) {
        expect(PERMISSION_KEYS).toContain(key);
      }
    }
  });
});

describe("LEGACY_ADMIN_ISOLATION：新 CAMPUS 角色不扩大 legacy /admin 桥", () => {
  it("CAMPUS_APPEAL_REVIEWER 授权上下文 → hasFullAdminSurfaceAccess=false", () => {
    const context = contextWithGrant([
      {
        roleKey: CAMPUS_APPEAL_REVIEWER_ROLE_KEY,
        scope: "CAMPUS",
        campusId: "A",
        permissionKeys: ["appeal.review"],
      },
    ]);
    expect(hasFullAdminSurfaceAccess(context)).toBe(false);
  });

  it("GLOBAL appeal.review 窄 grant（非全量）→ hasFullAdminSurfaceAccess=false", () => {
    const context = contextWithGrant([
      { roleKey: "NARROW", scope: "GLOBAL", campusId: null, permissionKeys: ["appeal.review"] },
    ]);
    expect(hasFullAdminSurfaceAccess(context)).toBe(false);
  });

  it("PLATFORM_ADMIN 全量 grant → hasFullAdminSurfaceAccess=true（回归）", () => {
    const context = contextWithGrant([
      {
        roleKey: PLATFORM_ADMIN_ROLE_KEY,
        scope: "GLOBAL",
        campusId: null,
        permissionKeys: [...PERMISSION_KEYS],
      },
    ]);
    expect(hasFullAdminSurfaceAccess(context)).toBe(true);
  });
});

describe("scopeKey 派生", () => {
  it("campusScopeKey 与 review-scope 的 CAMPUS:<id> 同规则", () => {
    expect(campusScopeKey("A")).toBe("CAMPUS:A");
    expect(GLOBAL_SCOPE_KEY).toBe("GLOBAL");
  });
});
