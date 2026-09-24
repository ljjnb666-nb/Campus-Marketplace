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
/** 非空 direct identity 列：不可 CLEAR，运行时为不可反查哨兵替换 */
const DIRECT_IDENTITY_PSEUDONYMIZED = entry("DIRECT_IDENTITY", "INCLUDE", "PSEUDONYMIZE", false, false);
const USER_CONTENT_FIELD = entry("USER_AUTHORED_CONTENT", "INCLUDE", "CLEAR", false, false);
const OPERATOR_ONLY_FIELD = entry("OPERATOR_ONLY", "EXCLUDE", "RETAIN_GOVERNANCE", false, false);
const CREDENTIAL_FIELD = entry("CREDENTIAL_SECRET", "EXCLUDE", "PSEUDONYMIZE", false, false);
const STORAGE_INTERNAL_FIELD = entry("STORAGE_METADATA", "EXCLUDE", "RETAIN_STRUCTURAL", false, false);

export const SENSITIVE_FIELD_EXPECTATIONS: FieldPrivacyPolicy[] = [
  // ---- User：direct identity + credential ----
  // name / email 均为非空列：注销 = 不可反查哨兵替换（PSEUDONYMIZE）
  field("User", "name", DIRECT_IDENTITY_PSEUDONYMIZED),
  field("User", "email", DIRECT_IDENTITY_PSEUDONYMIZED),
  field("User", "phone", DIRECT_IDENTITY_FIELD),
  field("User", "bio", DIRECT_IDENTITY_FIELD),
  field("User", "avatarUrl", DIRECT_IDENTITY_FIELD),
  field("User", "college", DIRECT_IDENTITY_FIELD),
  field("User", "grade", DIRECT_IDENTITY_FIELD),
  field("User", "studentIdLast4", DIRECT_IDENTITY_FIELD),
  // R4-01：schoolName 是 NON-NULLABLE direct identity——不可 CLEAR，
  // 注销 = REDACT（ERASED_USER_DISPLAY_NAME 哨兵；运行时与迁移一致）
  field("User", "schoolName", entry("DIRECT_IDENTITY", "INCLUDE", "REDACT", false, false)),
  field("User", "passwordHash", entry("CREDENTIAL_SECRET", "EXCLUDE", "PSEUDONYMIZE", false, false)),
  // ---- UserVerification：认证证据 + 审核自由文本（schoolName/campusName/
  //      studentIdLast4 均为非空列 → REDACT 哨兵，与运行时一致）----
  field("UserVerification", "schoolName", entry("DIRECT_IDENTITY", "SAFE_SUBSET", "REDACT", false, false)),
  field("UserVerification", "campusName", entry("DIRECT_IDENTITY", "SAFE_SUBSET", "REDACT", false, false)),
  field("UserVerification", "studentIdLast4", entry("DIRECT_IDENTITY", "SAFE_SUBSET", "REDACT", false, false)),
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
  // meetingLocation 是 buyer-authored（productOrderFormSchema /
  // serviceOrderFormSchema → createProductOrderTx/createServiceOrderTx）；
  // selfExport 与当前 Order export 合同一致（SAFE_SUBSET）
  field("Order", "meetingLocation", entry("USER_AUTHORED_CONTENT", "SAFE_SUBSET", "CLEAR", false, false)),
  // ---- RentalOrder ----
  field("RentalOrder", "renterNote", USER_CONTENT_FIELD),
  field("RentalOrder", "cancellationNote", USER_CONTENT_FIELD),
  // pickup/returnLocationSnapshot 是 owner-authored listing location 的
  // durable secondary copy（FINAL SECONDARY-COPY CLOSURE BLOCKER B）：
  // row/transaction history 保留（REDACT 哨兵），owner 注销后原始地点
  // 不得继续保存；renter 注销不清 owner 数据
  field("RentalOrder", "pickupLocationSnapshot", entry("TRANSACTION_HISTORY", "SAFE_SUBSET", "REDACT", false, false)),
  field("RentalOrder", "returnLocationSnapshot", entry("TRANSACTION_HISTORY", "SAFE_SUBSET", "REDACT", false, false)),
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

// ============================================================
// 4) 字段级 policy：listing / order 附属 user-authored 内容
//    （Repair 4 REVIEW FIX / R4-03：STRUCTURAL ROW RETENTION !=
//    USER CONTENT RETENTION——row 保留由 MODEL policy 表达
//    （TRANSACTION_HISTORY / RETAIN_STRUCTURAL），字段级
//    USER_AUTHORED_CONTENT 一律 CLEAR / REDACT，无 approved
//    retention exception。作者归属全部为唯一 actor 列：
//    publisherId / sellerId / providerId / ownerId（经 listing FK）/
//    submittedById / order.renterId / order.ownerId。）
// ============================================================

/** 可空 user-authored 文本：注销即置 null */
const CLEARED_USER_CONTENT = entry("USER_AUTHORED_CONTENT", "EXCLUDE", "CLEAR", false, false);
/** 非空 user-authored 文本：注销即置 ERASED_USER_CONTENT_MARKER */
const REDACTED_USER_CONTENT = entry("USER_AUTHORED_CONTENT", "EXCLUDE", "REDACT", false, false);

export const LISTING_USER_CONTENT_FIELD_POLICIES: FieldPrivacyPolicy[] = [
  field("BlockedUser", "reason", CLEARED_USER_CONTENT),
  // ---- ErrandTask（publisherId 唯一作者）----
  field("ErrandTask", "title", REDACTED_USER_CONTENT),
  field("ErrandTask", "description", REDACTED_USER_CONTENT),
  field("ErrandTask", "pickupLocation", REDACTED_USER_CONTENT),
  field("ErrandTask", "deliveryLocation", REDACTED_USER_CONTENT),
  field("ErrandTask", "contactNote", CLEARED_USER_CONTENT),
  // ---- Product（sellerId 唯一作者）----
  field("Product", "title", REDACTED_USER_CONTENT),
  field("Product", "description", REDACTED_USER_CONTENT),
  field("Product", "locationText", REDACTED_USER_CONTENT),
  field("Product", "images", entry("USER_AUTHORED_CONTENT", "EXCLUDE", "CLEAR", false, false)),
  // ---- ServiceListing（providerId 唯一作者）----
  field("ServiceListing", "title", REDACTED_USER_CONTENT),
  field("ServiceListing", "description", REDACTED_USER_CONTENT),
  field("ServiceListing", "locationText", REDACTED_USER_CONTENT),
  field("ServiceListing", "availableSchedule", CLEARED_USER_CONTENT),
  field("ServiceListing", "coverImageUrl", CLEARED_USER_CONTENT),
  // ---- RentalListing（ownerId 唯一作者）----
  field("RentalListing", "title", REDACTED_USER_CONTENT),
  field("RentalListing", "description", REDACTED_USER_CONTENT),
  field("RentalListing", "brand", CLEARED_USER_CONTENT),
  field("RentalListing", "model", CLEARED_USER_CONTENT),
  field("RentalListing", "pickupLocation", REDACTED_USER_CONTENT),
  field("RentalListing", "returnLocation", REDACTED_USER_CONTENT),
  field("RentalListing", "usageRules", CLEARED_USER_CONTENT),
  field("RentalListing", "damagePolicy", CLEARED_USER_CONTENT),
  field("RentalListing", "overduePolicy", CLEARED_USER_CONTENT),
  field("RentalListing", "images", entry("USER_AUTHORED_CONTENT", "EXCLUDE", "CLEAR", false, false)),
  // ---- RentalHandoverRecord（owner/renter 双方可写、无 per-field 归属 →
  //      participant erasure 规则：任一参与者注销即清，与 General Order
  //      participant-erasure 惯例一致）----
  field("RentalHandoverRecord", "accessories", CLEARED_USER_CONTENT),
  field("RentalHandoverRecord", "currentCondition", CLEARED_USER_CONTENT),
  field("RentalHandoverRecord", "knownIssues", CLEARED_USER_CONTENT),
  // ---- RentalDamageClaim / Extension / Return / Unavailable ----
  field("RentalDamageClaim", "damageDescription", REDACTED_USER_CONTENT),
  field("RentalDamageClaim", "renterNote", CLEARED_USER_CONTENT),
  field("RentalDamageClaim", "photos", entry("USER_AUTHORED_CONTENT", "EXCLUDE", "CLEAR", false, false)),
  field("RentalExtensionRequest", "ownerNote", CLEARED_USER_CONTENT),
  // inspectionNote = owner 验收自由文本（order.ownerId 精确归属）
  field("RentalReturnRecord", "inspectionNote", CLEARED_USER_CONTENT),
  field("RentalUnavailablePeriod", "reason", CLEARED_USER_CONTENT),
  // ---- STORAGE_METADATA 引用面（非自由文本）----
  // RentalHandoverRecord.photos / RentalReturnRecord.photos 是双确认覆盖
  // 语义的混合归属资产引用数组（ownerConfirmed/renterConfirmed 无 per-photo
  // attribution）——不得按作者清空。它们不是 personal free text 而是
  // controlled-asset locator：被引用 HANDOVER/RETURN 资产在 erasure 时
  // PENDING_DELETE → 对象物理删除，locator 保留与 bucket/objectKey 同构
  // （cleanup provenance）。
  field("RentalHandoverRecord", "photos", STORAGE_INTERNAL_FIELD),
  field("RentalReturnRecord", "photos", STORAGE_INTERNAL_FIELD),
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
// USER INPUT FIELD INVENTORY SSOT（REVIEW ROUND 2 / FIELD-COVERAGE GAP）
// ------------------------------------------------------------------
// 确认"由普通用户表单/domain action 自由填写并持久化"的字段清单。
// completeness 的权威依据不是 SENSITIVE_FIELD_NAME_PATTERN（那只是
// unknown-sensitive-name detector），而是本清单 + REGISTRY-06/07/08。
// source = 该字段进入系统的表单 schema / action 入口。
// ============================================================

export type UserInputFieldExpectation = {
  model: string;
  field: string;
  /**
   * 真实当前生产 writer（validator schema key / canonical service input）。
   * 同一字段有多个 writer 时列出全部；每个 symbol 必须真实存在
   * （REGISTRY-09 CURRENT_SOURCE_TRUTH 断言）。
   */
  sources: string[];
};

export const USER_INPUT_FIELD_EXPECTATIONS: UserInputFieldExpectation[] = [
  // Product（productFormSchema / product actions）
  { model: "Product", field: "title", sources: ["productFormSchema.title"] },
  { model: "Product", field: "description", sources: ["productFormSchema.description"] },
  { model: "Product", field: "locationText", sources: ["productFormSchema.locationText"] },
  // ErrandTask（errand form / errand actions）
  { model: "ErrandTask", field: "title", sources: ["errandFormSchema.title"] },
  { model: "ErrandTask", field: "description", sources: ["errandFormSchema.description"] },
  { model: "ErrandTask", field: "pickupLocation", sources: ["errandFormSchema.pickupLocation"] },
  { model: "ErrandTask", field: "deliveryLocation", sources: ["errandFormSchema.deliveryLocation"] },
  { model: "ErrandTask", field: "contactNote", sources: ["errandFormSchema.contactNote"] },
  // ServiceListing（service form / service actions）
  { model: "ServiceListing", field: "title", sources: ["serviceFormSchema.title"] },
  { model: "ServiceListing", field: "description", sources: ["serviceFormSchema.description"] },
  { model: "ServiceListing", field: "locationText", sources: ["serviceFormSchema.locationText"] },
  { model: "ServiceListing", field: "availableSchedule", sources: ["serviceFormSchema.availableSchedule"] },
  { model: "ServiceListing", field: "coverImageUrl", sources: ["serviceFormSchema.coverImageUrl"] },
  // RentalListing（rental form / rental-listing actions）
  { model: "RentalListing", field: "title", sources: ["rentalFormSchema.title"] },
  { model: "RentalListing", field: "description", sources: ["rentalFormSchema.description"] },
  { model: "RentalListing", field: "brand", sources: ["rentalFormSchema.brand"] },
  { model: "RentalListing", field: "model", sources: ["rentalFormSchema.model"] },
  { model: "RentalListing", field: "pickupLocation", sources: ["rentalFormSchema.pickupLocation"] },
  { model: "RentalListing", field: "returnLocation", sources: ["rentalFormSchema.returnLocation"] },
  { model: "RentalListing", field: "usageRules", sources: ["rentalFormSchema.usageRules"] },
  { model: "RentalListing", field: "damagePolicy", sources: ["rentalFormSchema.damagePolicy"] },
  { model: "RentalListing", field: "overduePolicy", sources: ["rentalFormSchema.overduePolicy"] },
  // RentalHandoverRecord（rentalPickupConfirmSchema：owner/renter 双方可写，
  // 无 per-field author attribution → participant-erasure 规则清空）。
  // accessories 无当前生产 writer（schema 只有 currentCondition/knownIssues），
  // 属 HISTORICAL_ONLY——保留 field policy 与 erasure coverage，不入本清单。
  { model: "RentalHandoverRecord", field: "currentCondition", sources: ["rentalPickupConfirmSchema.currentCondition"] },
  { model: "RentalHandoverRecord", field: "knownIssues", sources: ["rentalPickupConfirmSchema.knownIssues"] },
  // RentalDamageClaim / Extension / Return / Unavailable
  { model: "RentalDamageClaim", field: "damageDescription", sources: ["rentalDamageClaimSchema.damageDescription"] },
  { model: "RentalDamageClaim", field: "renterNote", sources: ["rentalDamageRespondSchema.renterNote"] },
  // ownerNote 无当前生产 writer（approveExtensionTx/rejectExtensionTx input
  // 仅 id+userId）→ HISTORICAL_ONLY，保留 policy 与 erasure coverage。
  { model: "RentalReturnRecord", field: "inspectionNote", sources: ["rentalReturnConfirmSchema.inspectionNote"] },
  { model: "RentalUnavailablePeriod", field: "reason", sources: ["rentalUnavailablePeriodForm.reason"] },
  // Order（productOrderFormSchema / serviceOrderFormSchema）
  { model: "Order", field: "meetingLocation", sources: ["productOrderFormSchema.meetingLocation", "serviceOrderFormSchema.meetingLocation"] },
  { model: "Order", field: "note", sources: ["productOrderFormSchema.note", "serviceOrderFormSchema.note"] },
  // Order.cancelReason 不在当前生产输入清单：它由 updateOrderStatusTx 在
  // CANCELLED 时系统生成（"用户主动取消"），不是用户输入。field policy、
  // ERASURE_FIELD_COVERAGE 与 erasure/migration 保护全部保留（历史数据
  // 可能含自由文本，清理属安全纵深防御）。
  // Review / RentalReview
  { model: "Review", field: "content", sources: ["reviewFormSchema.content"] },
  { model: "Review", field: "tags", sources: ["reviewFormSchema.tags"] },
  { model: "RentalReview", field: "content", sources: ["rentalReviewFormSchema.content"] },
  // RentalOrder free text
  { model: "RentalOrder", field: "renterNote", sources: ["rentalOrderCreateSchema.renterNote"] },
  { model: "RentalOrder", field: "cancellationNote", sources: ["rentalCancelSchema.cancellationNote", "rentalRejectSchema.rejectReason"] },
  // Message / Support / Appeal / Report / Dispute / Blocked
  { model: "Message", field: "content", sources: ["sendMessageAction.content"] },
  { model: "SupportTicket", field: "subject", sources: ["supportTicketFormSchema.subject"] },
  { model: "SupportTicket", field: "description", sources: ["supportTicketFormSchema.description"] },
  { model: "Appeal", field: "statement", sources: ["appealFormSchema.statement"] },
  { model: "Report", field: "detail", sources: ["reportFormSchema.detail"] },
  { model: "RentalDispute", field: "reason", sources: ["initiateDisputeSchema.reason"] },
  { model: "BlockedUser", field: "reason", sources: ["blockUserAction.reason"] },
];

/**
 * SECONDARY-COPY 面（FINAL SECONDARY-COPY CLOSURE）：user-authored source →
 * durable derived copy 的映射登记。
 * - DURABLE_REDACT：copy 行保留（transaction history），owner 注销后原文以
 *   REDACT 哨兵收敛（当前 erasure + migration 双侧执行）
 * - FORBIDDEN：绝不允许写入派生面（未来写路径必须 generic system copy）
 */
export type SecondaryCopyExpectation = {
  sourceModel: string;
  sourceField: string;
  targetModel: string;
  targetField: string;
  policy: "DURABLE_REDACT" | "FORBIDDEN";
};

export const SECONDARY_COPY_FIELD_EXPECTATIONS: SecondaryCopyExpectation[] = [
  {
    sourceModel: "RentalListing",
    sourceField: "pickupLocation",
    targetModel: "RentalOrder",
    targetField: "pickupLocationSnapshot",
    policy: "DURABLE_REDACT",
  },
  {
    sourceModel: "RentalListing",
    sourceField: "returnLocation",
    targetModel: "RentalOrder",
    targetField: "returnLocationSnapshot",
    policy: "DURABLE_REDACT",
  },
  {
    sourceModel: "RentalListing",
    sourceField: "title",
    targetModel: "Notification",
    targetField: "content",
    policy: "FORBIDDEN",
  },
];

/**
 * REGISTRY-08 的字段级 erasure 执行登记：每条 USER_INPUT_FIELD_EXPECTATIONS
 * 必须出现在本集合（⊆ 关系），并另有集成/单元测试证明执行语义真实存在。
 */
export const ERASURE_FIELD_COVERAGE: ReadonlySet<string> = new Set([
  // Product
  "Product.title",
  "Product.description",
  "Product.locationText",
  "Product.images",
  // ErrandTask
  "ErrandTask.title",
  "ErrandTask.description",
  "ErrandTask.pickupLocation",
  "ErrandTask.deliveryLocation",
  "ErrandTask.contactNote",
  // ServiceListing
  "ServiceListing.title",
  "ServiceListing.description",
  "ServiceListing.locationText",
  "ServiceListing.availableSchedule",
  "ServiceListing.coverImageUrl",
  // RentalListing
  "RentalListing.title",
  "RentalListing.description",
  "RentalListing.brand",
  "RentalListing.model",
  "RentalListing.pickupLocation",
  "RentalListing.returnLocation",
  "RentalListing.usageRules",
  "RentalListing.damagePolicy",
  "RentalListing.overduePolicy",
  "RentalListing.images",
  // RentalHandoverRecord（participant erasure；accessories 为 HISTORICAL_ONLY
  // 但 erasure/migration 仍执行清空——保留执行登记）
  "RentalHandoverRecord.accessories",
  "RentalHandoverRecord.currentCondition",
  "RentalHandoverRecord.knownIssues",
  // RentalDamageClaim / Extension / Return / Unavailable
  "RentalDamageClaim.damageDescription",
  "RentalDamageClaim.renterNote",
  "RentalDamageClaim.photos",
  "RentalExtensionRequest.ownerNote",
  "RentalReturnRecord.inspectionNote",
  "RentalUnavailablePeriod.reason",
  // Blocked / Dispute / Report / Review / Message / Support / Appeal
  "BlockedUser.reason",
  "RentalDispute.reason",
  "RentalDispute.evidencePhotos",
  "Report.detail",
  "Review.content",
  "Review.tags",
  "RentalReview.content",
  "RentalReview.tags",
  "Message.content",
  "SupportTicket.subject",
  "SupportTicket.description",
  "SupportTicket.resolutionMessage",
  "SupportTicket.internalNote",
  "Appeal.statement",
  "Order.note",
  "Order.cancelReason",
  "Order.meetingLocation",
  "RentalOrder.renterNote",
  "RentalOrder.cancellationNote",
  "RentalOrder.pickupLocationSnapshot",
  "RentalOrder.returnLocationSnapshot",
  "RentalOrderStatusLog.note",
]);

// ============================================================
// 查询 helper
// ============================================================

/**
 * REGISTRY-05 判定依据：每个含 USER_AUTHORED_CONTENT 字段的 model 必须在
 * account-erasure.ts 的注销执行路径中被实际处理（模型名以 Prisma client
 * 访问形式出现在该文件源码中），或存在显式 approvedRetentionException。
 * 本轮 approved exception = 0。
 */
export const ERASURE_IMPLEMENTATION_MODELS: ReadonlySet<string> = new Set([
  "User",
  "UserVerification",
  "CampusMembership",
  "UploadedAsset",
  "Notification",
  "Message",
  "Review",
  "RentalReview",
  "Report",
  "Appeal",
  "Order",
  "RentalOrder",
  "RentalOrderStatusLog",
  "RentalDispute",
  "SupportTicket",
  "Session",
  "Product",
  "ErrandTask",
  "ServiceListing",
  "RentalListing",
  "ProductImage",
  "RentalListingImage",
  "BlockedUser",
  "RentalDamageClaim",
  "RentalExtensionRequest",
  "RentalUnavailablePeriod",
  "RentalReturnRecord",
  "RentalHandoverRecord",
]);

/** 经外部审计批准的保留例外（本轮 = 空；新增必须附审计证据） */
export const APPROVED_RETENTION_EXCEPTIONS: ReadonlySet<string> = new Set([]);

function buildFieldPolicyIndex(): Map<string, FieldPrivacyPolicy> {
  const index = new Map<string, FieldPrivacyPolicy>();
  for (const policy of [
    ...SENSITIVE_FIELD_EXPECTATIONS,
    ...GOVERNANCE_FIELD_POLICIES,
    ...LISTING_USER_CONTENT_FIELD_POLICIES,
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

/**
 * 敏感命名启发式（CI drift detector 用；不是运行时安全边界）。
 * 定位（REVIEW ROUND 2 §20）：本 pattern 只是 UNKNOWN-SENSITIVE-NAME
 * detector（新出现敏感命名字段必须人工分类）；user-input completeness
 * 的权威是 USER_INPUT_FIELD_EXPECTATIONS + REGISTRY-06/07/08。
 */
export const SENSITIVE_FIELD_NAME_PATTERN =
  /(email|phone|name|note|content|description|reason|statement|image|filename|token|secret|password|avatar|bio|studentid|detail|photos)/i;
