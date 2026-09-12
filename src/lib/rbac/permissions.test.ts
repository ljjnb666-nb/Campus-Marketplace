import { describe, expect, it } from "vitest";

import { ADMIN_SURFACE_PERMISSION_KEYS, asPermissionKey, PERMISSIONS, PERMISSION_KEYS } from "@/lib/rbac/permissions";
import { PLATFORM_ADMIN_ROLE_KEY, SYSTEM_ROLES } from "@/lib/rbac/roles";

describe("rbac permission keys（机器可读稳定标识）", () => {
  it("keys follow the domain.action lowercase style", () => {
    for (const key of PERMISSION_KEYS) {
      expect(key).toMatch(/^[a-z]+\.[a-z.]+$/);
    }
  });

  it("derives the platform admin grant set from the full permission list", () => {
    // Phase 7A：新增 CAMPUS_APPEAL_REVIEWER（scope=CAMPUS，仅 appeal.review），
    // PLATFORM_ADMIN 仍是唯一全量 GLOBAL 角色（定义合同见 roles.test.ts）
    expect(SYSTEM_ROLES).toHaveLength(2);
    const platformAdmin = SYSTEM_ROLES.find((role) => role.key === PLATFORM_ADMIN_ROLE_KEY);
    expect(platformAdmin).toBeDefined();
    expect(platformAdmin!.scope).toBe("GLOBAL");
    expect(new Set(platformAdmin!.permissionKeys)).toEqual(new Set(PERMISSION_KEYS));
  });

  it("exposes exactly one description per permission", () => {
    expect(Object.keys(PERMISSIONS)).toHaveLength(PERMISSION_KEYS.length);
    for (const description of Object.values(PERMISSIONS)) {
      expect(description.length).toBeGreaterThan(0);
    }
  });

  it("narrows unknown keys to null（DEFAULT_DENY 的输入侧守卫）", () => {
    expect(asPermissionKey("verification.review")).toBe("verification.review");
    expect(asPermissionKey("Verification.Review")).toBeNull();
    expect(asPermissionKey("nonexistent.permission")).toBeNull();
    // 原型链污染键不可作为 permission
    expect(asPermissionKey("toString")).toBeNull();
  });

  it("keeps the admin surface bridge non-empty and aligned with the permission set", () => {
    expect(ADMIN_SURFACE_PERMISSION_KEYS.length).toBeGreaterThan(0);
    expect(new Set(ADMIN_SURFACE_PERMISSION_KEYS)).toEqual(new Set(PERMISSION_KEYS));
  });
});
