/**
 * 隐私数据分类注册表（Repair 4 / RB-04 中央 SSOT）。
 *
 * 本文件是全系统 personal data 生命周期的唯一分类权威：
 * - self-export：INCLUDE（用户本人的完整数据）/ SAFE_SUBSET（仅白名单安全
 *   子集）/ EXCLUDE（结构性不存在于任何用户导出）
 * - erasure：账号注销时该数据必须经历的处置——CLEAR（置 null/删除内容）/
 *   PSEUDONYMIZE（不可反查替换）/ DELETE（整行删除）/ REDACT（非空列置
 *   哨兵标记）/ RETAIN_STRUCTURAL（交易结构历史保留行）/ RETAIN_GOVERNANCE
 *   （治理审计保留）
 * - secondaryCopyAllowed：NO = 该数据的原始值绝不能被复制进派生面
 *   （Notification.content / RentalOrderStatusLog.note 等）；YES = 显式豁免
 * - logSafe：NO = 绝不允许进入任何结构化日志载荷
 *
 * 红线（与外部冻结分类一致，实现不得放宽）：
 * - GOVERNANCE_AUDIT / OPERATOR_ONLY 只能输出显式 user-visible 子集；
 *   actor/decisionNote/内部 provenance 绝不进入 self-export
 * - CREDENTIAL_SECRET 永不 self-export
 * - STORAGE_METADATA 的私有存储定位符（bucket/objectKey）绝不进入 self-export
 * - DERIVED_EPHEMERAL（Notification）绝不能成为 user free text 的第二权威副本
 *
 * Drift gate（REGISTRY-02）：Prisma schema 中任何命中敏感命名启发式的字段，
 * 必须在本注册表中被显式分类（三张分类表之一），否则测试失败并要求人工
 * classification。本表是 CI drift detector 的判定依据，不是运行时安全边界。
 */

export const PRIVACY_DATA_CLASSES = [
  "DIRECT_IDENTITY",
  "USER_AUTHORED_CONTENT",
  "TRANSACTION_HISTORY",
  "DERIVED_EPHEMERAL",
  "GOVERNANCE_AUDIT",
  "OPERATOR_ONLY",
  "STORAGE_METADATA",
  "CREDENTIAL_SECRET",
] as const;

export type PrivacyDataClass = (typeof PRIVACY_DATA_CLASSES)[number];

export const SELF_EXPORT_MODES = ["INCLUDE", "SAFE_SUBSET", "EXCLUDE"] as const;
export type SelfExportMode = (typeof SELF_EXPORT_MODES)[number];

export const ERASURE_MODES = [
  "CLEAR",
  "PSEUDONYMIZE",
  "DELETE",
  "REDACT",
  "RETAIN_STRUCTURAL",
  "RETAIN_GOVERNANCE",
] as const;
export type ErasureMode = (typeof ERASURE_MODES)[number];

/** 账号注销后 user-authored 自由文本的统一哨兵标记（非空列替换值） */
export const ERASED_USER_CONTENT_MARKER = "（该内容已随账号注销删除）";

/**
 * 历史 Notification.content 的迁移脱敏标记（DERIVED_EPHEMERAL 允许牺牲旧
 * derived copy；历史行无法可靠定位作者，禁止启发式猜测，统一置本标记）。
 */
export const HISTORICAL_NOTIFICATION_CONTENT_MARKER =
  "历史通知详情已按隐私策略清理，请查看相关业务记录。";

export type PrivacyPolicyEntry = {
  /** 声明该字段/模型归属的冻结隐私类别 */
  classification: PrivacyDataClass;
  selfExport: SelfExportMode;
  erasure: ErasureMode;
  secondaryCopyAllowed: boolean;
  logSafe: boolean;
};

export type ModelPrivacyPolicy = PrivacyPolicyEntry & {
  model: string;
};

export type FieldPrivacyPolicy = PrivacyPolicyEntry & {
  model: string;
  field: string;
};

function entry(
  classification: PrivacyDataClass,
  selfExport: SelfExportMode,
  erasure: ErasureMode,
  secondaryCopyAllowed: boolean,
  logSafe: boolean,
): PrivacyPolicyEntry {
  return { classification, selfExport, erasure, secondaryCopyAllowed, logSafe };
}

// ============================================================
// 1) 冻结 personal-bearing model 级 policy（REGISTRY-01 的判定集合）
// ============================================================

export const FROZEN_PERSONAL_MODELS = [
  "User",
  "UserVerification",
  "Message",
  "Review",
  "RentalReview",
  "Report",
  "Appeal",
  "Notification",
  "Order",
  "RentalOrder",
  "RentalOrderStatusLog",
  "RentalDispute",
  "SupportTicket",
  "UploadedAsset",
  "PrivacyRequest",
  "PolicyAcceptance",
] as const;

export type FrozenPersonalModel = (typeof FROZEN_PERSONAL_MODELS)[number];

/**
 * Model 级 policy 描述该表的**主导**隐私类别与生命周期基调；
 * 字段级差异由 SENSITIVE_FIELD_EXPECTATIONS 细化（如 User.passwordHash）。
 */
export const MODEL_PRIVACY_POLICIES: Record<FrozenPersonalModel, ModelPrivacyPolicy> = {
  User: {
    model: "User",
    ...entry("DIRECT_IDENTITY", "INCLUDE", "PSEUDONYMIZE", false, false),
  },
  UserVerification: {
    model: "UserVerification",
    ...entry("DIRECT_IDENTITY", "SAFE_SUBSET", "CLEAR", false, false),
  },
  Message: {
    model: "Message",
    ...entry("USER_AUTHORED_CONTENT", "INCLUDE", "REDACT", false, false),
  },
  Review: {
    model: "Review",
    ...entry("USER_AUTHORED_CONTENT", "INCLUDE", "CLEAR", false, false),
  },
  RentalReview: {
    model: "RentalReview",
    ...entry("USER_AUTHORED_CONTENT", "INCLUDE", "CLEAR", false, false),
  },
  Report: {
    model: "Report",
    ...entry("USER_AUTHORED_CONTENT", "SAFE_SUBSET", "CLEAR", false, false),
  },
  Appeal: {
    model: "Appeal",
    ...entry("USER_AUTHORED_CONTENT", "INCLUDE", "REDACT", false, false),
  },
  Notification: {
    model: "Notification",
    ...entry("DERIVED_EPHEMERAL", "INCLUDE", "DELETE", false, false),
  },
  Order: {
    model: "Order",
    ...entry("TRANSACTION_HISTORY", "SAFE_SUBSET", "RETAIN_STRUCTURAL", false, false),
  },
  RentalOrder: {
    model: "RentalOrder",
    ...entry("TRANSACTION_HISTORY", "SAFE_SUBSET", "RETAIN_STRUCTURAL", false, false),
  },
  RentalOrderStatusLog: {
    model: "RentalOrderStatusLog",
    ...entry("TRANSACTION_HISTORY", "EXCLUDE", "RETAIN_STRUCTURAL", false, false),
  },
  RentalDispute: {
    model: "RentalDispute",
    ...entry("USER_AUTHORED_CONTENT", "EXCLUDE", "REDACT", false, false),
  },
  SupportTicket: {
    model: "SupportTicket",
    ...entry("USER_AUTHORED_CONTENT", "SAFE_SUBSET", "REDACT", false, false),
  },
  UploadedAsset: {
    model: "UploadedAsset",
    ...entry("STORAGE_METADATA", "SAFE_SUBSET", "RETAIN_STRUCTURAL", false, false),
  },
  PrivacyRequest: {
    model: "PrivacyRequest",
    ...entry("GOVERNANCE_AUDIT", "SAFE_SUBSET", "RETAIN_GOVERNANCE", false, false),
  },
  PolicyAcceptance: {
    model: "PolicyAcceptance",
    ...entry("GOVERNANCE_AUDIT", "INCLUDE", "RETAIN_GOVERNANCE", false, false),
  },
};

// ============================================================
// 2) 字段级 policy：冻结敏感字段（消失即 REGISTRY-01 FAIL）
// ============================================================

function field(
  model: string,
  field: string,
  policy: PrivacyPolicyEntry,
): FieldPrivacyPolicy {
  return { model, field, ...policy };
}

const DIRECT_IDENTITY_FIELD = entry("DIRECT_IDENTITY", "INCLUDE", "CLEAR", false, false);
const USER_CONTENT_FIELD = entry("USER_AUTHORED_CONTENT", "INCLUDE", "CLEAR", false, false);
const OPERATOR_ONLY_FIELD = entry("OPERATOR_ONLY", "EXCLUDE", "RETAIN_GOVERNANCE", false, false);
const CREDENTIAL_FIELD = entry("CREDENTIAL_SECRET", "EXCLUDE", "PSEUDONYMIZE", false, false);
const STORAGE_INTERNAL_FIELD = entry("STORAGE_METADATA", "EXCLUDE", "RETAIN_STRUCTURAL", false, false);

export const SENSITIVE_FIELD_EXPECTATIONS: FieldPrivacyPolicy[] = [
  // ---- User：direct identity + credential ----
  field("User", "name", DIRECT_IDENTITY_FIELD),
  field("User", "email", DIRECT_IDENTITY_FIELD),
  field("User", "phone", DIRECT_IDENTITY_FIELD),
  field("User", "bio", DIRECT_IDENTITY_FIELD),
  field("User", "avatarUrl", DIRECT_IDENTITY_FIELD),
  field("User", "college", DIRECT_IDENTITY_FIELD),
  field("User", "grade", DIRECT_IDENTITY_FIELD),
  field("User", "studentIdLast4", DIRECT_IDENTITY_FIELD),
  field("User", "schoolName", DIRECT_IDENTITY_FIELD),
  field("User", "passwordHash", entry("CREDENTIAL_SECRET", "EXCLUDE", "PSEUDONYMIZE", false, false)),
  // ---- UserVerification：认证证据 + 审核自由文本 ----
  field("UserVerification", "schoolName", DIRECT_IDENTITY_FIELD),
  field("UserVerification", "campusName", DIRECT_IDENTITY_FIELD),
  field("UserVerification", "studentIdLast4", DIRECT_IDENTITY_FIELD),
  field("UserVerification", "studentCardImage", entry("DIRECT_IDENTITY", "EXCLUDE", "REDACT", false, false)),
  field("UserVerification", "reviewNote", entry("OPERATOR_ONLY", "EXCLUDE", "CLEAR", false, false)),
  // 认证决定的机器可读原因码：GOVERNANCE decision 记录，但 spec 冻结其进入
  // 本人 verification safe-subset 导出（不含 reviewNote / reviewedById）
  field("UserVerification", "reasonCode", entry("GOVERNANCE_AUDIT", "INCLUDE", "RETAIN_GOVERNANCE", true, true)),
  // ---- Message ----
  field("Message", "content", entry("USER_AUTHORED_CONTENT", "INCLUDE", "REDACT", false, false)),
  // ---- Review / RentalReview ----
  field("Review", "content", USER_CONTENT_FIELD),
  field("Review", "tags", USER_CONTENT_FIELD),
  field("RentalReview", "content", USER_CONTENT_FIELD),
  field("RentalReview", "tags", USER_CONTENT_FIELD),
  // ---- Report：本人 detail 是 self-export；handledNote 是 operator 治理 ----
  field("Report", "detail", USER_CONTENT_FIELD),
  field("Report", "handledNote", OPERATOR_ONLY_FIELD),
  // ---- Appeal：statement 是本人内容；decisionNote 是内部审核自由文本 ----
  field("Appeal", "statement", USER_CONTENT_FIELD),
  field("Appeal", "decisionNote", OPERATOR_ONLY_FIELD),
  // ---- Notification：derived ephemeral，绝不做 free text 第二权威副本 ----
  field("Notification", "content", entry("DERIVED_EPHEMERAL", "INCLUDE", "DELETE", false, false)),
  // ---- Order ----
  field("Order", "note", USER_CONTENT_FIELD),
  field("Order", "cancelReason", USER_CONTENT_FIELD),
  // ---- RentalOrder ----
  field("RentalOrder", "renterNote", USER_CONTENT_FIELD),
  field("RentalOrder", "cancellationNote", USER_CONTENT_FIELD),
  // ---- RentalOrderStatusLog：只允许 system-generated description ----
  field("RentalOrderStatusLog", "note", entry("TRANSACTION_HISTORY", "EXCLUDE", "CLEAR", false, false)),
  // ---- RentalDispute ----
  field("RentalDispute", "reason", USER_CONTENT_FIELD),
  field("RentalDispute", "evidencePhotos", entry("USER_AUTHORED_CONTENT", "EXCLUDE", "CLEAR", false, false)),
  field("RentalDispute", "adminNote", OPERATOR_ONLY_FIELD),
  // ---- SupportTicket：subject/description/resolutionMessage=用户可见，
  //      internalNote=OPERATOR_ONLY ----
  field("SupportTicket", "subject", USER_CONTENT_FIELD),
  field("SupportTicket", "description", USER_CONTENT_FIELD),
  field("SupportTicket", "resolutionMessage", USER_CONTENT_FIELD),
  field("SupportTicket", "internalNote", OPERATOR_ONLY_FIELD),
  // ---- UploadedAsset：文件名是潜在 PII；bucket/objectKey 私有定位符 ----
  field("UploadedAsset", "originalFileName", entry("STORAGE_METADATA", "INCLUDE", "CLEAR", false, false)),
  field("UploadedAsset", "objectKey", STORAGE_INTERNAL_FIELD),
  field("UploadedAsset", "bucket", STORAGE_INTERNAL_FIELD),
  // ---- PrivacyRequest：handledNote 不导出 ----
  field("PrivacyRequest", "handledNote", OPERATOR_ONLY_FIELD),
];

// ============================================================
// 3) 字段级 policy：治理 / 凭据面（非冻结 16 表，但必须显式分类）
// ============================================================

export const GOVERNANCE_FIELD_POLICIES: FieldPrivacyPolicy[] = [
  field("AdminLog", "detail", entry("GOVERNANCE_AUDIT", "EXCLUDE", "RETAIN_GOVERNANCE", false, false)),
  field("Appeal", "decisionReasonCode", entry("GOVERNANCE_AUDIT", "INCLUDE", "RETAIN_GOVERNANCE", true, true)),
  field("EnforcementAction", "note", OPERATOR_ONLY_FIELD),
  field("EnforcementAction", "reasonCode", entry("GOVERNANCE_AUDIT", "INCLUDE", "RETAIN_GOVERNANCE", true, true)),
  field("DataHold", "note", entry("GOVERNANCE_AUDIT", "EXCLUDE", "RETAIN_GOVERNANCE", false, false)),
  field("DataHold", "reasonCode", entry("GOVERNANCE_AUDIT", "EXCLUDE", "RETAIN_GOVERNANCE", false, false)),
  field("ListingModeration", "note", OPERATOR_ONLY_FIELD),
  field("ListingModeration", "reasonCode", entry("GOVERNANCE_AUDIT", "EXCLUDE", "RETAIN_GOVERNANCE", false, false)),
  field("PrivacyRequest", "reasonCode", entry("GOVERNANCE_AUDIT", "INCLUDE", "RETAIN_GOVERNANCE", true, true)),
  field("RiskFlag", "note", entry("GOVERNANCE_AUDIT", "EXCLUDE", "RETAIN_GOVERNANCE", false, false)),
  field("RiskFlag", "reasonCode", entry("GOVERNANCE_AUDIT", "EXCLUDE", "RETAIN_GOVERNANCE", false, false)),
  field("RiskState", "reasonCode", entry("GOVERNANCE_AUDIT", "EXCLUDE", "RETAIN_GOVERNANCE", false, false)),
  // CREDENTIAL_SECRET：永不导出；注销/会话吊销按既有机制失效
  field("Account", "access_token", CREDENTIAL_FIELD),
  field("Account", "id_token", CREDENTIAL_FIELD),
  field("Account", "refresh_token", CREDENTIAL_FIELD),
  field("Account", "token_type", CREDENTIAL_FIELD),
  field("Session", "sessionToken", CREDENTIAL_FIELD),
  field("VerificationToken", "token", CREDENTIAL_FIELD),
];

// ============================================================
// 4) 字段级 policy：已分类的 user-authored listing/order 附属内容。
//    这些表面在冻结的 Repair-4 注销矩阵之外（矩阵只要求特定 surfaces），
//    现行为 = listing 下架 / 订单终局后行保留，文本随行保留。此处显式
//    声明为 RETAIN_STRUCTURAL 以保证 drift gate 全量收敛；若未来冻结
//    分类扩展注销清理范围，必须先经外部审计修订本表。
// ============================================================

const RETAINED_LISTING_CONTENT = entry("USER_AUTHORED_CONTENT", "EXCLUDE", "RETAIN_STRUCTURAL", false, false);

export const RETAINED_USER_CONTENT_FIELD_POLICIES: FieldPrivacyPolicy[] = [
  field("BlockedUser", "reason", RETAINED_LISTING_CONTENT),
  field("ErrandTask", "description", RETAINED_LISTING_CONTENT),
  field("ErrandTask", "contactNote", RETAINED_LISTING_CONTENT),
  field("Product", "description", RETAINED_LISTING_CONTENT),
  field("Product", "images", RETAINED_LISTING_CONTENT),
  field("ServiceListing", "description", RETAINED_LISTING_CONTENT),
  field("ServiceListing", "coverImageUrl", RETAINED_LISTING_CONTENT),
  field("RentalListing", "description", RETAINED_LISTING_CONTENT),
  field("RentalListing", "images", RETAINED_LISTING_CONTENT),
  field("RentalDamageClaim", "damageDescription", RETAINED_LISTING_CONTENT),
  field("RentalDamageClaim", "renterNote", RETAINED_LISTING_CONTENT),
  field("RentalDamageClaim", "photos", RETAINED_LISTING_CONTENT),
  field("RentalExtensionRequest", "ownerNote", RETAINED_LISTING_CONTENT),
  field("RentalHandoverRecord", "photos", RETAINED_LISTING_CONTENT),
  field("RentalReturnRecord", "inspectionNote", RETAINED_LISTING_CONTENT),
  field("RentalReturnRecord", "photos", RETAINED_LISTING_CONTENT),
  field("RentalUnavailablePeriod", "reason", RETAINED_LISTING_CONTENT),
];

// ============================================================
// 5) 非个人字段 allowlist（敏感命名启发式的显式豁免，附理由）
// ============================================================

export const DECLARED_NON_PERSONAL_FIELDS: Array<{ model: string; field: string; because: string }> = [
  { model: "Campus", field: "name", because: "校区公开名称（平台参考数据）" },
  { model: "Campus", field: "schoolName", because: "校区公开学校名（平台参考数据）" },
  { model: "Role", field: "name", because: "角色机器名" },
  { model: "Permission", field: "description", because: "权限定义描述（平台元数据）" },
  { model: "ErrandCategory", field: "name", because: "类目参考数据" },
  { model: "ErrandCategory", field: "description", because: "类目参考数据" },
  { model: "ServiceCategory", field: "name", because: "类目参考数据" },
  { model: "ServiceCategory", field: "description", because: "类目参考数据" },
  { model: "RentalCategory", field: "name", because: "类目参考数据" },
  { model: "RentalCategory", field: "description", because: "类目参考数据" },
  { model: "ProductCategory", field: "name", because: "类目参考数据" },
  { model: "ProductCategory", field: "description", because: "类目参考数据" },
  { model: "LegalDocument", field: "content", because: "法务文档正文（平台发布内容）" },
  { model: "LegalDocument", field: "contentHash", because: "文档完整性哈希" },
  { model: "CampusVerificationPolicy", field: "contentHash", because: "策略完整性哈希" },
  { model: "RentalOrder", field: "cancellationReason", because: "机器可读取消类别枚举（非自由文本）" },
  { model: "Report", field: "reason", because: "机器可读举报类别枚举（非自由文本）" },
];

// ============================================================
// 查询 helper
// ============================================================

function buildFieldPolicyIndex(): Map<string, FieldPrivacyPolicy> {
  const index = new Map<string, FieldPrivacyPolicy>();
  for (const policy of [
    ...SENSITIVE_FIELD_EXPECTATIONS,
    ...GOVERNANCE_FIELD_POLICIES,
    ...RETAINED_USER_CONTENT_FIELD_POLICIES,
  ]) {
    index.set(`${policy.model}.${policy.field}`, policy);
  }
  return index;
}

const FIELD_POLICY_INDEX = buildFieldPolicyIndex();

/** 查询字段级 policy；未分类字段返回 null（drift gate 与测试据此失败） */
export function getFieldPrivacyPolicy(model: string, field: string): FieldPrivacyPolicy | null {
  return FIELD_POLICY_INDEX.get(`${model}.${field}`) ?? null;
}

export function getModelPrivacyPolicy(model: string): ModelPrivacyPolicy | null {
  return (MODEL_PRIVACY_POLICIES as Record<string, ModelPrivacyPolicy>)[model] ?? null;
}

/** 敏感命名启发式（CI drift detector 用；不是运行时安全边界） */
export const SENSITIVE_FIELD_NAME_PATTERN =
  /(email|phone|name|note|content|description|reason|statement|image|filename|token|secret|password|avatar|bio|studentid|detail|photos)/i;
