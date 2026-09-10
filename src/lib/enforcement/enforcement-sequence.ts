import type { EnforcementActionType, Prisma } from "@prisma/client";

/**
 * Phase 6C-1A：执法动作因果序与溯源分类的唯一权威模块。
 *
 * 两个维度正交且都冻结（因果序权威 != 反转溯源完整性）：
 *
 * - 因果序（causal order）：仅由 enforcementSeq 承载（DB sequence，
 *   LEGACY_SEQ_BOUNDARY 之前为 legacy epoch）。createdAt / id 只是展示与
 *   wall-clock 审计字段，绝不允许参与任何治理判定（latest / stale check /
 *   新旧比较）。
 * - 反转溯源完整性（reversal provenance）：仅由 previousState 非空承载。
 *
 * 因此本模块刻意不提供 `isAuthoritativeAction(previousState != null)` 这类
 * 单维 helper——`previousState != null => authoritative` 是被冻结禁止的
 * 退化判定。ROLLBACK_COMPAT 行（seq >= boundary 且 previousState = null）
 * 仍正常参与 latest 排序，但不可自动反转。
 *
 * sequence gap 冻结为 VALID：rollback / failed INSERT 会烧号，
 * 任何业务不变量只允许比较 `<` / `>` / `MAX`，禁止 `seqB == seqA + 1`。
 */

/**
 * legacy epoch 与 post-migration enforcement epoch 的分界。
 * seq <  boundary → PRE_MIGRATION_LEGACY_ACTION（内部相对顺序 NON_AUTHORITATIVE）
 * seq >= boundary → CAUSALLY_ORDERED_ACTION
 *
 * 用 BigInt(...) 构造而非字面量：仓库 TS target 为 ES2017（BigInt 字面量
 * 需要 ES2020），BigInt 值本身运行时可用。
 */
export const LEGACY_SEQ_BOUNDARY = BigInt(1_000_000_000);

/** 分类判定所需的最小行形状（真实 DB 行 / 测试 fixture 均可）。 */
export type EnforcementActionSequenceRow = {
  enforcementSeq: bigint;
  previousState: string | null;
};

/** seq < LEGACY_SEQ_BOUNDARY：迁移前 legacy 行（历史顺序不可信，仅分类用）。 */
export function isPreMigrationLegacy(
  action: EnforcementActionSequenceRow,
): boolean {
  return action.enforcementSeq < LEGACY_SEQ_BOUNDARY;
}

/** seq >= LEGACY_SEQ_BOUNDARY：post-migration epoch，seq 即因果序。 */
export function isCausallyOrdered(
  action: EnforcementActionSequenceRow,
): boolean {
  return action.enforcementSeq >= LEGACY_SEQ_BOUNDARY;
}

/** 反转溯源完整性：仅由 previousState 非空决定，与因果序无关。 */
export function hasCompleteReversalProvenance(
  action: EnforcementActionSequenceRow,
): boolean {
  return action.previousState !== null;
}

/** 可自动反转 = 因果序权威 且 反转溯源完整（两个正交条件的合取）。 */
export function isAutoReversible(
  action: EnforcementActionSequenceRow,
): boolean {
  return isCausallyOrdered(action) && hasCompleteReversalProvenance(action);
}

// ---------------------------------------------------------------------------
// Enforcement families（冻结；scopeKey 由调用方按精确 scope 匹配）
// ---------------------------------------------------------------------------

export const ACCOUNT_FAMILY = [
  "ACCOUNT_SUSPEND",
  "ACCOUNT_REINSTATE",
] as const satisfies readonly EnforcementActionType[];

export const MEMBERSHIP_FAMILY = [
  "MEMBERSHIP_SUSPEND",
  "MEMBERSHIP_REINSTATE",
] as const satisfies readonly EnforcementActionType[];

export const RISK_FAMILY = [
  "MARKETPLACE_RESTRICT",
  "MARKETPLACE_RESTORE",
] as const satisfies readonly EnforcementActionType[];

const ALL_FAMILIES: readonly (readonly EnforcementActionType[])[] = [
  ACCOUNT_FAMILY,
  MEMBERSHIP_FAMILY,
  RISK_FAMILY,
];

/**
 * 动作所属 family（同族动作在同一 target + 同一精确 scope 内互相 supersede）。
 * ACCOUNT family scope 恒为 GLOBAL；MEMBERSHIP scope 恒为 CAMPUS:<campusId>；
 * RISK family 可为 GLOBAL 或 CAMPUS:<campusId>。
 * 未映射类型（未来新增 enum 且未纳入 family）返回空数组 → latest 查询无同族。
 */
export function familyOf(
  type: EnforcementActionType,
): readonly EnforcementActionType[] {
  return ALL_FAMILIES.find((family) => family.includes(type)) ?? [];
}

/** 处罚向：SUSPEND / RESTRICT。 */
export function isPunitive(type: EnforcementActionType): boolean {
  return (
    type === "ACCOUNT_SUSPEND" ||
    type === "MEMBERSHIP_SUSPEND" ||
    type === "MARKETPLACE_RESTRICT"
  );
}

/** 恢复向：REINSTATE / RESTORE。 */
export function isRestorative(type: EnforcementActionType): boolean {
  return (
    type === "ACCOUNT_REINSTATE" ||
    type === "MEMBERSHIP_REINSTATE" ||
    type === "MARKETPLACE_RESTORE"
  );
}

// ---------------------------------------------------------------------------
// latest same-family resolution
// ---------------------------------------------------------------------------

export type LatestSameFamilyInput = {
  targetId: string;
  /** 精确 scope（GLOBAL 或 CAMPUS:<campusId>），跨 scope 不互相 supersede */
  scopeKey: string;
  /** 目标动作类型；查询其整个 family */
  type: EnforcementActionType;
};

export type EnforcementActionRecord = NonNullable<
  Awaited<
    ReturnType<Prisma.TransactionClient["enforcementAction"]["findFirst"]>
  >
>;

/**
 * 同 target + 同 family + 同精确 scope 的最新执法动作。
 *
 * latest 只由 enforcementSeq DESC 决定；刻意不按 createdAt / id /
 * previousState 过滤或排序——ROLLBACK_COMPAT 行（previousState = null，
 * seq >= boundary）可以正确 supersede 更早的动作。
 */
export async function latestSameFamilyAction(
  tx: Prisma.TransactionClient,
  input: LatestSameFamilyInput,
): Promise<EnforcementActionRecord | null> {
  const family = familyOf(input.type);
  if (family.length === 0) {
    return null;
  }

  return tx.enforcementAction.findFirst({
    where: {
      targetId: input.targetId,
      scopeKey: input.scopeKey,
      type: { in: [...family] },
    },
    orderBy: { enforcementSeq: "desc" },
  });
}
