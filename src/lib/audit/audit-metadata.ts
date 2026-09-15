/**
 * Phase 7D：AdminLog.metadata 读侧披露策略（Planning DECISION_03A / R3 冻结）。
 *
 * 写侧 ALLOWED_METADATA_KEYS（admin-audit.ts）只证明 *safe to persist*
 * （结构上挡敏感载荷），不证明 *safe / useful to display*——两份清单
 * 不得互相替代，本模块独立定义读侧投影：
 *
 * - DISPLAY_SAFE（14 key）：机器可读枚举/字面量，带 key 专用中文 label 展示；
 * - INTERNAL_POINTER_ONLY（7 key）：行指针（policyId/assetId/targetUserId/
 *   sourceId/appealId/enforcementActionId/moderationId），持久化但 7D 一律
 *   不渲染；未来若需展示必须逐 key 走"专用 label + 显式 rationale"新决策；
 * - 未知键 / 非原始类型值：读取时一律丢弃（fail closed；直写 AdminLog 的
 *   legacy 路径同样经过本投影）。
 *
 * 组件只接受本模块输出的 Array<{key, label, value}>——raw metadata object
 * 永不进入 React 组件（R3-04）。数值有界展示（截断），不无上限渲染。
 */

export type AuditMetadataEntry = {
  key: string;
  label: string;
  value: string;
};

/** 读侧 DISPLAY_SAFE 白名单：key → 展示 label（专用中文标签）。 */
const AUDIT_READ_METADATA_KEYS = {
  decision: "决定",
  policyVersion: "策略版本",
  assetCategory: "资产类别",
  grantedBy: "访问依据",
  roleKey: "角色",
  reasonCode: "原因码",
  scopeKey: "范围",
  riskState: "风险状态",
  resultState: "结果状态",
  sourceType: "来源类型",
  appealStatus: "申诉状态",
  decisionReasonCode: "裁决原因码",
  selfReview: "自查",
  listingType: "列表类型",
} as const satisfies Record<string, string>;

/** 读侧内部指针清单（仅文档语义：这些 key 在读侧被丢弃，绝不渲染）。 */
export const AUDIT_INTERNAL_POINTER_KEYS = [
  "policyId",
  "assetId",
  "targetUserId",
  "sourceId",
  "appealId",
  "enforcementActionId",
  "moderationId",
] as const;

/** 单值展示上限：超过即截断（机器码实际远短于此；防御任意长 primitive）。 */
export const AUDIT_METADATA_MAX_VALUE_LENGTH = 120;

/**
 * 把 AdminLog.metadata（Json?）投影为安全展示条目。
 * 顺序 = 写入对象键序（确定性）；null/undefined 值不产出条目；
 * boolean 归一为 是/否；string/number 归一为 String 并有界截断。
 */
export function projectAuditMetadata(metadata: unknown): AuditMetadataEntry[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }

  const entries: AuditMetadataEntry[] = [];
  for (const [key, rawValue] of Object.entries(metadata as Record<string, unknown>)) {
    const label = (AUDIT_READ_METADATA_KEYS as Record<string, string | undefined>)[key];
    // INTERNAL_POINTER_ONLY 与未知键一律不产出（结构上不可表达）
    if (!label) {
      continue;
    }
    if (rawValue === null || rawValue === undefined) {
      continue;
    }
    if (
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "boolean"
    ) {
      continue;
    }

    const normalized =
      typeof rawValue === "boolean" ? (rawValue ? "是" : "否") : String(rawValue);
    const value =
      normalized.length > AUDIT_METADATA_MAX_VALUE_LENGTH
        ? `${normalized.slice(0, AUDIT_METADATA_MAX_VALUE_LENGTH)}…`
        : normalized;

    entries.push({ key, label, value });
  }

  return entries;
}
