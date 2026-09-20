import { describe, expect, it } from "vitest";

import {
  ADMIN_SURFACE_PERMISSION_KEYS,
  asPermissionKey,
  LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS,
  PERMISSIONS,
  PERMISSION_KEYS,
} from "@/lib/rbac/permissions";
import { PLATFORM_ADMIN_ROLE_KEY, SYSTEM_ROLES } from "@/lib/rbac/roles";

describe("rbac permission keys（机器可读稳定标识）", () => {
  it("keys follow the domain.action lowercase style", () => {
    for (const key of PERMISSION_KEYS) {
      expect(key).toMatch(/^[a-z]+\.[a-z.]+$/);
    }
  });

  it("derives the platform admin grant set from the full permission list", () => {
    // Phase 7A：新增 CAMPUS_APPEAL_REVIEWER（scope=CAMPUS，仅 appeal.review）；
    // Phase 7C：新增 CAMPUS_CONTENT_MODERATOR（scope=CAMPUS，仅 listing.moderate）；
    // Phase 7E：新增 CAMPUS_REPORT_REVIEWER（scope=CAMPUS，仅 report.review）；
    // Phase 7F：新增 CAMPUS_VERIFICATION_REVIEWER（scope=CAMPUS，恰
    // verification.review + verification.evidence.read 两 key）；
    // Phase 7G：新增 CAMPUS_DISPUTE_REVIEWER（恰 dispute.review +
    // dispute.evidence.read）与 CAMPUS_SUPPORT_AGENT（恰 support.manage）；
    // PLATFORM_ADMIN 仍是唯一全量 GLOBAL 角色（定义合同见 roles.test.ts）
    expect(SYSTEM_ROLES).toHaveLength(7);
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
});

describe("Phase 7D R1：legacy full-admin 等价集合与全集分离", () => {
  it("enforcement.read 是已知 permission（DEFAULT_DENY 输入侧可收窄）", () => {
    expect(asPermissionKey("enforcement.read")).toBe("enforcement.read");
    expect(PERMISSIONS["enforcement.read"]).toBe(
      "读取执法记录与账户限制状态（治理运营可见性）",
    );
  });

  it("LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS 显式冻结为 pre-7D 的 11 key", () => {
    expect([...LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS].sort()).toEqual(
      [
        "verification.review",
        "report.review",
        "listing.moderate",
        "category.manage",
        "moderation.keyword.manage",
        "user.suspend",
        "appeal.review",
        "asset.sensitive.read",
        "campus.manage",
        "rbac.role.assign",
        "audit.read",
      ].sort(),
    );
  });

  it("enforcement.read NOT IN legacy 集合；legacy 集合不再随全集派生（R1 核心）", () => {
    expect(LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS).not.toContain("enforcement.read");
    expect(PERMISSION_KEYS).toContain("enforcement.read");
    expect(LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS.length).toBeLessThan(PERMISSION_KEYS.length);
  });

  it("legacy /admin 桥判定集合 = LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS（baseline 等价）", () => {
    expect(ADMIN_SURFACE_PERMISSION_KEYS).toBe(LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS);
  });

  it("PLATFORM_ADMIN 仍自动获得 enforcement.read（R1-03 定义层）", () => {
    const platformAdmin = SYSTEM_ROLES.find((role) => role.key === PLATFORM_ADMIN_ROLE_KEY);
    expect(platformAdmin!.permissionKeys).toContain("enforcement.read");
  });
});

// ── Phase 7H：operations.overview 窄读取 permission（GLOBAL only）───────────
describe("Phase 7H：operations.overview（运营级系统概览）", () => {
  it("operations.overview 是已知 permission（DEFAULT_DENY 输入侧可收窄）", () => {
    expect(asPermissionKey("operations.overview")).toBe("operations.overview");
    expect(PERMISSIONS["operations.overview"]).toBe(
      "读取平台运行状态与安全的运营级系统概览",
    );
  });

  it("operations.overview NOT IN legacy 集合（R1 冻结不动：恰 11 key 零变化）", () => {
    expect(LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS).not.toContain("operations.overview");
    expect(LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS).toHaveLength(11);
    expect(PERMISSION_KEYS).toContain("operations.overview");
    expect(ADMIN_SURFACE_PERMISSION_KEYS).toBe(LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS);
  });

  it("PLATFORM_ADMIN 因全量派生自然获得 operations.overview（无需新角色/assignment）", () => {
    const platformAdmin = SYSTEM_ROLES.find((role) => role.key === PLATFORM_ADMIN_ROLE_KEY);
    expect(platformAdmin!.permissionKeys).toContain("operations.overview");
    // campus 角色零变化：无任何 CAMPUS 角色携带 operations.overview
    for (const role of SYSTEM_ROLES) {
      if (role.scope === "CAMPUS") {
        expect(role.permissionKeys).not.toContain("operations.overview");
      }
    }
  });
});
