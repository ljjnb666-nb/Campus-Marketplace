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
  "OrderDispute",
  "SupportTicket",
  "UploadedAsset",
  "PrivacyRequest",
  "PolicyAcceptance",
  // Phase 9C-03：隐私导出 artifact（system-generated derived copy；
  // 短 TTL，S3 PII 对象到期/注销物理删除，DB 行保留 DELETED 墓碑）
  "DataExportArtifact",
  // Phase 9C-04：async/outbox 基础设施模型正式登记（§39）——payload 由
  // zod strict 契约在写边界强制（只允许 IDs + 机器状态），retention 时
  // COMPLETED/PUBLISHED 行 in-place compaction 为机器 tombstone marker
  "AsyncJob",
  "OutboxEvent",
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
  // Phase 8C-01：与 RentalDispute 同分类同基调（governance provenance 保留）
  OrderDispute: {
    model: "OrderDispute",
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
  // Phase 9C-03：DataExportArtifact 是 user-linked PII derivative——
  // 用户请求导出时由系统生成的本人数据 JSON 副本（campus-marketplace.
  // user-export/v3，application/json）。derived ephemeral：
  // - 绝不是 authoritative source record，也绝不为 legal hold 永久保留
  //   （DataHold 保护 authoritative user/governance data，artifact 只是
  //   短 TTL 派生副本，ACTIVE hold 不阻断其到期清理）；
  // - selfExport EXCLUDE：artifact 自身绝不进入导出载荷（否则自引用
  //   无穷），bucket/objectKey 属 STORAGE_METADATA 结构性缺席；
  // - erasure RETAIN_STRUCTURAL（RB03-B：与 runtime 精确一致）：注销时
  //   全部 WRITING/READY artifact 原子标记 PENDING_DELETE（account-erasure
  //   执行），storage cleanup 幂等 DeleteObject 后行转移 DELETED 并保留
  //   机器墓碑（deletedAt + bucket/objectKey 结构性恢复/审计元数据）——
  //   用户导出 bytes（S3 对象）已物理删除，行内不含任何用户内容；registry
  //   的 DELETE（整行删除）语义不适用于本表（FK Restrict 见 schema 注释，
  //   recovery metadata 不得被 parent cascade 静默抹除）；
  // - secondaryCopyAllowed=true：该模型本身就是用户明确授权的导出副本
  //   （DATA_EXPORT 权利实现），TTL 有界、删除幂等；
  // - 不计入 User.storageUsedBytes（用户导出自身数据绝不被 quota 阻断）。
  DataExportArtifact: {
    model: "DataExportArtifact",
    ...entry("DERIVED_EPHEMERAL", "EXCLUDE", "RETAIN_STRUCTURAL", true, false),
  },
  PolicyAcceptance: {
    model: "PolicyAcceptance",
    ...entry("GOVERNANCE_AUDIT", "INCLUDE", "RETAIN_GOVERNANCE", false, false),
  },
  // Phase 9C-04（§39）：async/outbox 基础设施 = DERIVED_EPHEMERAL 运行时面。
  // payload 只允许 IDs + 机器状态（zod strict 写边界 + 执行边界双层强制，
  // RB04）；绝不为 legal hold 永久保留——terminal retention 的正确收敛是
  // in-place compaction tombstone（payload → 机器 marker，dedupeKey UNIQUE
  // 作为 exactly-once / replay suppression authority 永久保留，绝不 DELETE
  // 行）；DEAD_LETTER 保留至运维解决（未决事件，非 retention candidate）。
  // - selfExport EXCLUDE：job/event intent 不是用户数据副本；
  // - erasure RETAIN_STRUCTURAL：行保留（幂等身份 + 执行 provenance），
  //   注销用户产生的 job 行随 retention 窗口 compaction，与用户注销无关；
  // - secondaryCopyAllowed=false：payload 绝不复制进派生面；
  // - logSafe=false：payload / dedupeKey / lastErrorMessage 绝不进入日志
  //  （kind / schemaVersion / 安全 errorCode 允许，§80 观测白名单）。
  AsyncJob: {
    model: "AsyncJob",
    ...entry("DERIVED_EPHEMERAL", "EXCLUDE", "RETAIN_STRUCTURAL", false, false),
  },
  OutboxEvent: {
    model: "OutboxEvent",
    ...entry("DERIVED_EPHEMERAL", "EXCLUDE", "RETAIN_STRUCTURAL", false, false),
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
  // ---- Phase 9B：canonical notification identity（kind/version registry）----
  // kind / schemaVersion / payload 三列是 registry 契约的持久化投影：
  // payload 只允许 IDs + 机器状态（zod strict 契约在 canonical emit 写边界
  // 强制，非法即事务回滚零落库）；kind/version 允许进入结构化日志（§80 观测
  // 白名单），payload 本身不进日志。erasure 随 Notification 整行 DELETE。
  field("Notification", "kind", entry("DERIVED_EPHEMERAL", "INCLUDE", "DELETE", false, true)),
  field("Notification", "schemaVersion", entry("DERIVED_EPHEMERAL", "INCLUDE", "DELETE", false, true)),
  field("Notification", "payload", entry("DERIVED_EPHEMERAL", "INCLUDE", "DELETE", false, false)),
  // ---- Phase 9B：NotificationDelivery——channel delivery provenance ----
  // destination 是 CONTACT_INFO（收件邮箱）：DIRECT_IDENTITY，绝不误标
  // machine-only；绝不进入结构化日志（logSafe=false）、绝不 self-export
  // （本人邮箱已经由 User 面导出，delivery 快照属投递 provenance）；
  // 注销时运行时以 RECIPIENT_ERASED / retention 收敛为 redacted sentinel
  // （与行保留配套的 REDACT，执行在 account-erasure）。
  field("NotificationDelivery", "destination", entry("DIRECT_IDENTITY", "EXCLUDE", "REDACT", false, false)),
  // provider / providerMessageId / providerIdempotencyKey / suppressionCode
  // 是机器 provenance（渠道实现名、外部 message id、deterministic 幂等键
  // notification/<id>/email/v1、受控机器码）：非 personal，行保留。
  field("NotificationDelivery", "provider", entry("STORAGE_METADATA", "EXCLUDE", "RETAIN_STRUCTURAL", false, true)),
  field("NotificationDelivery", "providerMessageId", entry("STORAGE_METADATA", "EXCLUDE", "RETAIN_STRUCTURAL", false, true)),
  field("NotificationDelivery", "providerIdempotencyKey", entry("STORAGE_METADATA", "EXCLUDE", "RETAIN_STRUCTURAL", false, true)),
  field("NotificationDelivery", "suppressionCode", entry("STORAGE_METADATA", "EXCLUDE", "RETAIN_STRUCTURAL", false, true)),
  // ---- Phase 9A：async 基础设施错误诊断元数据 ----
  // 声明与代码事实一致（RB02/RB04/RB05 修复后）：
  // - payload：只允许 IDs + 机器状态，由 zod strict schema 在【生产写边界】
  //   强制（enqueueAsyncJobTx / recordOutboxEventTx 校验失败 → 事务回滚零
  //   落库），并在【执行边界】再次校验（未知 kind/version/payload → 运行时
  //   DEAD_LETTER）；双层 fail closed。
  // - lastErrorCode：CONTROLLED MACHINE CODE ONLY（受控内部码 / Prisma
  //   P#### 机器码 / Node 传输码显式 allowlist / 安全机器格式 Error.name；
  //   arbitrary exception 附加字段默认拒绝）。
  // - lastErrorMessage：DENY raw exception text BY DEFAULT（仅受控内部文案 /
  //   固定 generic message 落库）。
  // 两者均为 operator 专用诊断面：绝不 self-export、绝不作为第二副本进入
  // 日志（结构化日志只写 errorName/errorCode）；行保留为执行 provenance。
  field("AsyncJob", "lastErrorCode", OPERATOR_ONLY_FIELD),
  field("AsyncJob", "lastErrorMessage", OPERATOR_ONLY_FIELD),
  field("OutboxEvent", "lastErrorCode", OPERATOR_ONLY_FIELD),
  field("OutboxEvent", "lastErrorMessage", OPERATOR_ONLY_FIELD),
  // ---- Phase 9C-04：retention tombstone 标记（operational structural
  //      metadata，§40）——tombstonedAt 是机器 retention 转移时间戳，与
  //      terminal timestamps 同类；行保留语义见 model 级 policy 注释。
  field("AsyncJob", "tombstonedAt", entry("STORAGE_METADATA", "EXCLUDE", "RETAIN_STRUCTURAL", false, true)),
  field("OutboxEvent", "tombstonedAt", entry("STORAGE_METADATA", "EXCLUDE", "RETAIN_STRUCTURAL", false, true)),
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
  // ---- OrderDispute（Phase 8C-01：分类与 RentalDispute 完全一致）----
  field("OrderDispute", "reason", USER_CONTENT_FIELD),
  field("OrderDispute", "evidencePhotos", entry("USER_AUTHORED_CONTENT", "EXCLUDE", "CLEAR", false, false)),
  field("OrderDispute", "adminNote", OPERATOR_ONLY_FIELD),
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
  // ---- Phase 9C-03：DataExportArtifact 内部定位符与完整性元数据 ----
  // bucket/objectKey 与 UploadedAsset 同构（STORAGE_METADATA 绝不
  // self-export / 绝不进入 browser-visible surface）；sha256 是 artifact
  // 完整性摘要（机器 provenance，logSafe=true，绝不向用户展示）；
  // mimeType/sizeBytes/expiresAt 是非敏感机器元数据（不命中敏感命名
  // 启发式，status/requestId/userId 同）。
  field("DataExportArtifact", "bucket", STORAGE_INTERNAL_FIELD),
  field("DataExportArtifact", "objectKey", STORAGE_INTERNAL_FIELD),
  field("DataExportArtifact", "sha256", entry("STORAGE_METADATA", "EXCLUDE", "RETAIN_STRUCTURAL", false, true)),
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
  // ---- OrderMeetup（Phase 8D-01：proposedById 唯一作者）。custom location
  // 快照是 user-authored 非空列（erasure = REDACT 哨兵，作者注销后不得保留
  // 明文）；custom 判定依据 immutable locationSource（RB01）而非可空的
  // meetupPointId——MeetupPoint 行删除后该列被 SET NULL，来源语义仍在。
  // scheduledAt/status/no-show provenance 等交易结构字段保留（row =
  // transaction provenance）。
  field("OrderMeetup", "locationTextSnapshot", REDACTED_USER_CONTENT),
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
  // Phase 8D-01：见面点 catalog 是平台参考数据（ Campus.name 同构；8D-01 无
  // admin UI，fixture/未来治理面管理），不是任何用户的自由文本面
  { model: "MeetupPoint", field: "name", because: "见面点公开名称（平台参考数据）" },
  { model: "MeetupPoint", field: "locationText", because: "见面点公开位置描述（平台参考数据）" },
  // Phase 9A：async infra 的 lease fencing token（每次 claim 重新生成的机器
  // UUID，fencing authority）。两张表已在 Phase 9C-04 正式登记为
  // DERIVED_EPHEMERAL model 级 policy（见 MODEL_PRIVACY_POLICIES）：
  //   AsyncJob.payload / OutboxEvent.payload 只允许 IDs + 机器状态——由 zod
  //   strict schema 在生产写边界强制（enqueueAsyncJobTx /
  //   recordOutboxEventTx 校验失败即事务回滚零落库）并在执行边界二次校验
  //   （运行时 unknown → DEAD_LETTER），禁止 user-authored 自由文本 /
  //   secret / raw provider payload；
  //   lastErrorCode/lastErrorMessage 只存受控机器码 / 固定 generic 或受控
  //   内部文案（deny raw text by default），完整 stack 走结构化应用日志，
  //   绝不入库。
  { model: "AsyncJob", field: "leaseToken", because: "worker lease fencing token（机器 UUID，非用户数据）" },
  { model: "OutboxEvent", field: "leaseToken", because: "dispatcher lease fencing token（机器 UUID，非用户数据）" },
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
  // Phase 8C-01：domain writer 已存在；Phase 8C-02：生产用户入口
  // initiateGeneralOrderDispute（orderDisputeSchema.reason）开放——
  // writer/source lockstep 登记（明确推进 source inventory，非 allowlist hack）
  { model: "OrderDispute", field: "reason", sources: ["initiateOrderDisputeTx.reason", "initiateGeneralOrderDispute.reason"] },
  // Phase 8D-01：真实用户输入是 ProposeOrderMeetupInput.locationText
  // （canonical writer proposeOrderMeetupTx 消费并固化为 persisted derived
  // snapshot locationTextSnapshot；RB01 source-truth：登记输入属性本身，
  // 不登记不存在的 input property）。Phase 8D-02 表单入口开放时补充其
  // schema source。catalog 来源（locationSource=MEETUP_POINT）不是 user
  // input，不改写本条。
  { model: "OrderMeetup", field: "locationTextSnapshot", sources: ["proposeOrderMeetupTx.locationText"] },
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
  "OrderDispute.reason",
  "OrderDispute.evidencePhotos",
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
  // Phase 8D-01：custom location 快照 erasure 执行（account-erasure 按
  // proposedById + locationSource=CUSTOM 精确 REDACT——RB01：不用可空的
  // meetupPointId 推断来源）
  "OrderMeetup.locationTextSnapshot",
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
  "OrderDispute",
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
  // Phase 8D-01：meetup custom location 快照（proposedById 唯一作者）
  "OrderMeetup",
  // Phase 9C-03：导出 artifact 注销收敛（WRITING/READY → PENDING_DELETE）
  "DataExportArtifact",
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
