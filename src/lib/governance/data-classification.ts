/**
 * Phase 5 数据分类 / 保留策略 foundation（代码化 registry）。
 *
 * 这是 typed source of truth：Phase 6 RBAC、Phase 9 background retention
 * cleanup 必须复用这里的定义，不得在各自的 route 里重新发明分类。
 *
 * 红线：
 * - 不虚构法定保存年限。凡需要真实法律判断的 duration 一律
 *   LEGAL_REVIEW_REQUIRED = true + durationStatus: "PENDING_LEGAL_REVIEW"
 * - 日志类沿用 docs/LOG_PRIVACY.md 的真实规则（≤30 天 / 容器轮转），不另造一套
 */

export type DataClassification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";

export type RetentionDisposition = "KEEP" | "DELETE" | "ANONYMIZE" | "REVIEW_REQUIRED";

export type RetentionDurationStatus =
  | { kind: "FIXED_DAYS"; days: number }
  | { kind: "LIFECYCLE_BOUND"; note: string }
  | { kind: "PENDING_LEGAL_REVIEW"; note: string };

export type DataCategoryDefinition = {
  category: string;
  classification: DataClassification;
  /** 谁可以看：public=任何人；self=仅本人；authorized roles=业务授权角色 */
  visibility: "PUBLIC" | "SELF_ONLY" | "AUTHORIZED_ROLES_ONLY";
  retentionTrigger: string;
  retentionDuration: RetentionDurationStatus;
  disposition: RetentionDisposition;
  /** hold 是否应阻断该类数据的清理（破坏性 disposition 时应为 true） */
  holdBehavior: "HOLD_BLOCKS" | "HOLD_NOT_APPLICABLE";
  reason: string;
  /** 该类数据是否会进入用户导出 */
  exportable: boolean;
  /** 该类数据是否可以进入日志（见 docs/LOG_PRIVACY.md） */
  logSafe: boolean;
  legalReviewRequired: boolean;
};

export const DATA_CLASSIFICATION_REGISTRY: Record<string, DataCategoryDefinition> = {
  PUBLIC_PROFILE: {
    category: "PUBLIC_PROFILE",
    classification: "PUBLIC",
    visibility: "PUBLIC",
    retentionTrigger: "账号存续",
    retentionDuration: { kind: "LIFECYCLE_BOUND", note: "账号注销时随匿名化替换为占位表示" },
    disposition: "ANONYMIZE",
    holdBehavior: "HOLD_NOT_APPLICABLE",
    reason: "前台公开资料（昵称/头像/学校/校区/认证状态/统计），见 SECURITY.md 数据暴露约束",
    exportable: true,
    logSafe: true,
    legalReviewRequired: false,
  },
  LOGIN_IDENTIFIER_EMAIL: {
    category: "LOGIN_IDENTIFIER_EMAIL",
    classification: "CONFIDENTIAL",
    visibility: "SELF_ONLY",
    retentionTrigger: "账号存续；注销时替换为不可反查的匿名 surrogate",
    retentionDuration: { kind: "LIFECYCLE_BOUND", note: "注销即清除原始值" },
    disposition: "ANONYMIZE",
    holdBehavior: "HOLD_BLOCKS",
    reason: "登录标识符；不允许公开，不允许出现在导出他人数据或日志中",
    exportable: true,
    logSafe: false,
    legalReviewRequired: false,
  },
  PASSWORD_HASH: {
    category: "PASSWORD_HASH",
    classification: "RESTRICTED",
    visibility: "AUTHORIZED_ROLES_ONLY",
    retentionTrigger: "账号存续；注销时替换为随机无效哈希",
    retentionDuration: { kind: "LIFECYCLE_BOUND", note: "注销即失效" },
    disposition: "ANONYMIZE",
    holdBehavior: "HOLD_BLOCKS",
    reason: "认证凭据材料；永不出现在导出/日志/任何 API 响应中",
    exportable: false,
    logSafe: false,
    legalReviewRequired: false,
  },
  CAMPUS_VERIFICATION_DATA: {
    category: "CAMPUS_VERIFICATION_DATA",
    classification: "RESTRICTED",
    visibility: "AUTHORIZED_ROLES_ONLY",
    retentionTrigger: "提交认证时",
    retentionDuration: { kind: "FIXED_DAYS", days: 30 },
    disposition: "DELETE",
    holdBehavior: "HOLD_BLOCKS",
    reason: "学生证原图等审核材料：审核后保留 30 天删除原图（沿用 Phase 1 VERIFICATION_ASSET_RETENTION_DAYS 真实规则），认证结论保留",
    exportable: false,
    logSafe: false,
    legalReviewRequired: false,
  },
  PRIVATE_VERIFICATION_ASSET: {
    category: "PRIVATE_VERIFICATION_ASSET",
    classification: "RESTRICTED",
    visibility: "AUTHORIZED_ROLES_ONLY",
    retentionTrigger: "上传/业务绑定时",
    retentionDuration: { kind: "FIXED_DAYS", days: 30 },
    disposition: "DELETE",
    holdBehavior: "HOLD_BLOCKS",
    reason: "handover/return/report 等私有对象：短时签名访问 + 到期删除（Phase 1 语义）",
    exportable: false,
    logSafe: false,
    legalReviewRequired: false,
  },
  PRIVATE_MESSAGES: {
    category: "PRIVATE_MESSAGES",
    classification: "CONFIDENTIAL",
    visibility: "AUTHORIZED_ROLES_ONLY",
    retentionTrigger: "消息创建",
    retentionDuration: { kind: "PENDING_LEGAL_REVIEW", note: "会话双方可见；清理策略待 Phase 8/9 与法律审查确定" },
    disposition: "REVIEW_REQUIRED",
    holdBehavior: "HOLD_BLOCKS",
    reason: "双方私密通信；导出仅含本人发送内容，不得导出对方私密数据",
    exportable: true,
    logSafe: false,
    legalReviewRequired: true,
  },
  ORDER_DETAILS: {
    category: "ORDER_DETAILS",
    classification: "CONFIDENTIAL",
    visibility: "AUTHORIZED_ROLES_ONLY",
    retentionTrigger: "订单创建",
    retentionDuration: { kind: "PENDING_LEGAL_REVIEW", note: "交易历史涉及审计完整性；保存年限需法律审查" },
    disposition: "KEEP",
    holdBehavior: "HOLD_BLOCKS",
    reason: "订单/交易记录：注销后保留 pseudonymous 引用，维持 referential integrity",
    exportable: true,
    logSafe: false,
    legalReviewRequired: true,
  },
  REPORTS: {
    category: "REPORTS",
    classification: "CONFIDENTIAL",
    visibility: "AUTHORIZED_ROLES_ONLY",
    retentionTrigger: "举报创建",
    retentionDuration: { kind: "PENDING_LEGAL_REVIEW", note: "治理证据，处置年限需法律审查" },
    disposition: "KEEP",
    holdBehavior: "HOLD_BLOCKS",
    reason: "举报记录是平台治理证据；被举报人信息不得进入举报人导出",
    exportable: true,
    logSafe: false,
    legalReviewRequired: true,
  },
  DISPUTE_EVIDENCE: {
    category: "DISPUTE_EVIDENCE",
    classification: "RESTRICTED",
    visibility: "AUTHORIZED_ROLES_ONLY",
    retentionTrigger: "纠纷创建",
    retentionDuration: { kind: "PENDING_LEGAL_REVIEW", note: "纠纷/交接证据；DISPUTE hold 的主要客体" },
    disposition: "KEEP",
    holdBehavior: "HOLD_BLOCKS",
    reason: "纠纷证据在 DISPUTE hold 下不可删除；保留期需法律审查",
    exportable: false,
    logSafe: false,
    legalReviewRequired: true,
  },
  ADMIN_SECURITY_LOGS: {
    category: "ADMIN_SECURITY_LOGS",
    classification: "RESTRICTED",
    visibility: "AUTHORIZED_ROLES_ONLY",
    retentionTrigger: "事件发生",
    retentionDuration: { kind: "FIXED_DAYS", days: 30 },
    disposition: "DELETE",
    holdBehavior: "HOLD_BLOCKS",
    reason: "用户行为相关日志 ≤30 天（docs/LOG_PRIVACY.md §3 真实规则），容器轮转为物理上限",
    exportable: false,
    logSafe: false,
    legalReviewRequired: false,
  },
  REQUEST_IDS: {
    category: "REQUEST_IDS",
    classification: "INTERNAL",
    visibility: "AUTHORIZED_ROLES_ONLY",
    retentionTrigger: "请求发生",
    retentionDuration: { kind: "FIXED_DAYS", days: 30 },
    disposition: "DELETE",
    holdBehavior: "HOLD_NOT_APPLICABLE",
    reason: "correlation id，用于排障关联；随日志层保留期走",
    exportable: false,
    logSafe: true,
    legalReviewRequired: false,
  },
  UPLOADED_ASSET_METADATA: {
    category: "UPLOADED_ASSET_METADATA",
    classification: "INTERNAL",
    visibility: "SELF_ONLY",
    retentionTrigger: "资源登记",
    retentionDuration: { kind: "LIFECYCLE_BOUND", note: "对象删除后保留审计行（AssetStatus.DELETED）" },
    disposition: "KEEP",
    holdBehavior: "HOLD_NOT_APPLICABLE",
    reason: "登记表审计行不含对象内容；导出仅含本人元数据且排除 objectKey/bucket",
    exportable: true,
    logSafe: true,
    legalReviewRequired: false,
  },
  POLICY_ACCEPTANCE_EVIDENCE: {
    category: "POLICY_ACCEPTANCE_EVIDENCE",
    classification: "CONFIDENTIAL",
    visibility: "SELF_ONLY",
    retentionTrigger: "同意行为发生",
    retentionDuration: { kind: "LIFECYCLE_BOUND", note: "审计证据，随账号历史保留（注销后随 pseudonymous 行保留）" },
    disposition: "KEEP",
    holdBehavior: "HOLD_BLOCKS",
    reason: "同意证据不可篡改、不可伪造；销毁需走显式治理流程",
    exportable: true,
    logSafe: true,
    legalReviewRequired: false,
  },
  PRIVACY_REQUESTS: {
    category: "PRIVACY_REQUESTS",
    classification: "CONFIDENTIAL",
    visibility: "SELF_ONLY",
    retentionTrigger: "请求创建",
    retentionDuration: { kind: "PENDING_LEGAL_REVIEW", note: "隐私请求台账保留期需法律审查" },
    disposition: "KEEP",
    holdBehavior: "HOLD_BLOCKS",
    reason: "隐私请求历史是用户权利行使证据；仅本人与授权处理角色可见",
    exportable: true,
    logSafe: true,
    legalReviewRequired: true,
  },
  FUTURE_PAYMENT_DATA: {
    category: "FUTURE_PAYMENT_DATA",
    classification: "RESTRICTED",
    visibility: "AUTHORIZED_ROLES_ONLY",
    retentionTrigger: "未适用（Phase 15+）",
    retentionDuration: { kind: "PENDING_LEGAL_REVIEW", note: "支付域未开始；此条目是边界标记，防止误并入其他类别" },
    disposition: "REVIEW_REQUIRED",
    holdBehavior: "HOLD_BLOCKS",
    reason: "支付/结算数据在 GATE C 前不存在；引入时必须重新分类并满足金融级约束",
    exportable: false,
    logSafe: false,
    legalReviewRequired: true,
  },
};

/** 判定是否敏感类别（RESTRICTED/CONFIDENTIAL 视为敏感）。 */
export function isSensitiveDataCategory(category: string): boolean {
  const definition = DATA_CLASSIFICATION_REGISTRY[category];
  if (!definition) {
    // 未注册类别按敏感处理（fail closed）
    return true;
  }
  return (
    definition.classification === "RESTRICTED" || definition.classification === "CONFIDENTIAL"
  );
}

/** 是否允许进入用户导出。 */
export function canIncludeInExport(category: string): boolean {
  const definition = DATA_CLASSIFICATION_REGISTRY[category];
  return definition?.exportable === true;
}

export type RetentionDecision = {
  category: string;
  disposition: RetentionDisposition;
  duration: RetentionDurationStatus;
  holdBlocks: boolean;
  legalReviewRequired: boolean;
};

/** Phase 9 retention cleanup 将复用的决策入口（Phase 5 只做决策，不做调度）。 */
export function getRetentionDecision(category: string): RetentionDecision {
  const definition = DATA_CLASSIFICATION_REGISTRY[category];

  if (!definition) {
    // 未注册类别：不得清理（fail closed）
    return {
      category,
      disposition: "REVIEW_REQUIRED",
      duration: { kind: "PENDING_LEGAL_REVIEW", note: "未注册类别，禁止自动清理" },
      holdBlocks: true,
      legalReviewRequired: true,
    };
  }

  return {
    category: definition.category,
    disposition: definition.disposition,
    duration: definition.retentionDuration,
    holdBlocks: definition.holdBehavior === "HOLD_BLOCKS",
    legalReviewRequired: definition.legalReviewRequired,
  };
}
