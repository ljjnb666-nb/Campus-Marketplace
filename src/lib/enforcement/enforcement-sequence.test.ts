import { describe, expect, it, vi } from "vitest";

import type { EnforcementActionType } from "@prisma/client";

import {
  ACCOUNT_FAMILY,
  LEGACY_SEQ_BOUNDARY,
  MEMBERSHIP_FAMILY,
  RISK_FAMILY,
  familyOf,
  hasCompleteReversalProvenance,
  isAutoReversible,
  isCausallyOrdered,
  isPreMigrationLegacy,
  isPunitive,
  isRestorative,
  latestSameFamilyAction,
} from "@/lib/enforcement/enforcement-sequence";

function row(enforcementSeq: bigint, previousState: string | null) {
  return { enforcementSeq, previousState };
}

describe("LEGACY_SEQ_BOUNDARY（冻结 1_000_000_000）", () => {
  it("boundary 值被冻结", () => {
    expect(LEGACY_SEQ_BOUNDARY).toBe(BigInt(1_000_000_000));
  });

  it("boundary 本身属于 post-migration epoch（>= 判定）", () => {
    expect(isPreMigrationLegacy(row(LEGACY_SEQ_BOUNDARY, null))).toBe(false);
    expect(isCausallyOrdered(row(LEGACY_SEQ_BOUNDARY, null))).toBe(true);
    expect(isPreMigrationLegacy(row(LEGACY_SEQ_BOUNDARY - BigInt(1), null))).toBe(true);
    expect(isCausallyOrdered(row(LEGACY_SEQ_BOUNDARY - BigInt(1), null))).toBe(false);
  });
});

describe("两维正交分类（冻结四象限）", () => {
  it("PRE_MIGRATION_LEGACY：seq < boundary 且 previousState = null", () => {
    const action = row(BigInt(42), null);

    expect(isPreMigrationLegacy(action)).toBe(true);
    expect(isCausallyOrdered(action)).toBe(false);
    expect(hasCompleteReversalProvenance(action)).toBe(false);
    expect(isAutoReversible(action)).toBe(false);
  });

  it("NORMAL AUTHORITATIVE：seq >= boundary 且 previousState != null", () => {
    const action = row(BigInt(1_000_000_001), "USER:ACTIVE");

    expect(isPreMigrationLegacy(action)).toBe(false);
    expect(isCausallyOrdered(action)).toBe(true);
    expect(hasCompleteReversalProvenance(action)).toBe(true);
    expect(isAutoReversible(action)).toBe(true);
  });

  it("ROLLBACK_COMPAT：seq >= boundary 但 previousState = null（安全降级）", () => {
    const action = row(BigInt(1_000_000_002), null);

    expect(isPreMigrationLegacy(action)).toBe(false);
    expect(isCausallyOrdered(action)).toBe(true);
    expect(hasCompleteReversalProvenance(action)).toBe(false);
    expect(isAutoReversible(action)).toBe(false);
  });

  it("禁止单维退化：previousState 完整不等于可自动反转（legacy 行反例）", () => {
    // 人为构造：seq < boundary 且 previousState 非空 → 溯源完整但不可自动反转
    const weird = row(BigInt(7), "USER:ACTIVE");
    expect(hasCompleteReversalProvenance(weird)).toBe(true);
    expect(isAutoReversible(weird)).toBe(false);
  });

  it("模块刻意不提供 isAuthoritativeAction 单维 helper", async () => {
    const mod = await import("@/lib/enforcement/enforcement-sequence");
    expect(mod).not.toHaveProperty("isAuthoritativeAction");
  });
});

describe("enforcement families（冻结三族）", () => {
  it("ACCOUNT family scope 恒 GLOBAL；MEMBERSHIP 恒 CAMPUS:*；RISK 两者皆可", () => {
    expect([...ACCOUNT_FAMILY]).toEqual(["ACCOUNT_SUSPEND", "ACCOUNT_REINSTATE"]);
    expect([...MEMBERSHIP_FAMILY]).toEqual(["MEMBERSHIP_SUSPEND", "MEMBERSHIP_REINSTATE"]);
    expect([...RISK_FAMILY]).toEqual(["MARKETPLACE_RESTRICT", "MARKETPLACE_RESTORE"]);
  });

  it("familyOf 覆盖全部六类动作", () => {
    const all: EnforcementActionType[] = [
      "ACCOUNT_SUSPEND",
      "ACCOUNT_REINSTATE",
      "MEMBERSHIP_SUSPEND",
      "MEMBERSHIP_REINSTATE",
      "MARKETPLACE_RESTRICT",
      "MARKETPLACE_RESTORE",
    ];
    for (const type of all) {
      expect(familyOf(type).length).toBe(2);
      expect(familyOf(type)).toContain(type);
    }
  });

  it("isPunitive / isRestorative 互斥且覆盖全部六类", () => {
    const all: EnforcementActionType[] = [
      "ACCOUNT_SUSPEND",
      "ACCOUNT_REINSTATE",
      "MEMBERSHIP_SUSPEND",
      "MEMBERSHIP_REINSTATE",
      "MARKETPLACE_RESTRICT",
      "MARKETPLACE_RESTORE",
    ];
    for (const type of all) {
      expect(isPunitive(type)).toBe(!isRestorative(type));
    }
    expect(isPunitive("ACCOUNT_SUSPEND")).toBe(true);
    expect(isRestorative("ACCOUNT_REINSTATE")).toBe(true);
    expect(isPunitive("MARKETPLACE_RESTRICT")).toBe(true);
    expect(isRestorative("MARKETPLACE_RESTORE")).toBe(true);
  });
});

describe("latestSameFamilyAction（latest 仅由 enforcementSeq 决定）", () => {
  it("按 family 查询同 target + 同精确 scope，orderBy enforcementSeq desc", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const tx = {
      enforcementAction: { findFirst },
    } as unknown as Parameters<typeof latestSameFamilyAction>[0];

    await latestSameFamilyAction(tx, {
      targetId: "target-1",
      scopeKey: "CAMPUS:campus-a",
      type: "MEMBERSHIP_SUSPEND",
    });

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        targetId: "target-1",
        scopeKey: "CAMPUS:campus-a",
        type: { in: ["MEMBERSHIP_SUSPEND", "MEMBERSHIP_REINSTATE"] },
      },
      orderBy: { enforcementSeq: "desc" },
    });
    // 禁止按 previousState 过滤（ROLLBACK_COMPAT 行可 supersede）：
    const call = findFirst.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(call.where.previousState).toBeUndefined();
    // 禁止 createdAt / id 参与 latest 判定
    expect(call.where.createdAt).toBeUndefined();
    expect(Object.keys(call.where)).not.toContain("id");
  });

  it("未映射类型返回 null（不查询）", async () => {
    const findFirst = vi.fn();
    const tx = {
      enforcementAction: { findFirst },
    } as unknown as Parameters<typeof latestSameFamilyAction>[0];

    const unknownType = "MYSTERY_TYPE" as EnforcementActionType;
    await expect(
      latestSameFamilyAction(tx, { targetId: "t", scopeKey: "GLOBAL", type: unknownType }),
    ).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});
