/**
 * Phase 6A：permission key 的唯一定义来源（machine-readable 稳定标识）。
 *
 * 约定：
 * - key 采用 `域.动作` 小写点分风格，一旦发布不得改名（审计/角色数据引用它）
 * - permission set 从现有 admin 能力推导（Phase 6A 审计），不为未来 Phase 预留
 * - 未知 permission 一律 DENY（DEFAULT_DENY，见 src/lib/rbac/service.ts）
 */

export const PERMISSIONS = {
  "verification.review": "审核校园成员认证材料并作出决定",
  "report.review": "受理与处理举报",
  "listing.moderate": "对商品/跑腿/服务/租赁列表执行治理处置",
  "category.manage": "管理商品/跑腿/服务分类",
  "moderation.keyword.manage": "管理敏感词规则",
  "user.suspend": "停用/恢复用户账号",
  // Phase 6C-1B：申诉审核（review scope 流转/UPHELD/DISMISSED；GRANT 另需
  // 通过 canonical enforcement seam 自身的权限复核，appeal.review 不构成 bypass）
  "appeal.review": "审核用户对执法处罚提交的申诉",
  "asset.sensitive.read": "因治理/审核目的访问敏感私有材料（认证材料等）",
  "campus.manage": "管理校区与校园认证策略版本",
  "rbac.role.assign": "授予/撤回用户角色",
  "audit.read": "读取管理审计日志",
  // Phase 7D：执法可见性（纯 governance read capability——仅授权读取
  // EnforcementAction / RiskState 运营读面，不含任何 mutation 权）。
  // 刻意不属于下方 LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS（R1 冻结）：
  // 新增 read capability 绝不允许静默改变 legacy /admin 资格或
  // privileged-target 分类。
  "enforcement.read": "读取执法记录与账户限制状态（治理运营可见性）",
  // Phase 7F：认证证据窄读取（纯 read capability）。语义严格限定为
  // "仅访问 verification-bound private evidence"（UploadedAsset.category ==
  // VERIFICATION 且 campus 精确匹配；其它 category 一律 NO ACCESS）——
  // 不构成任何其它私有资产的读取权，也不进入 legacy 11-key 等价集合。
  "verification.evidence.read": "读取校园认证绑定的私有证据材料（仅认证材料）",
  // Phase 7G：租赁纠纷运营（mutation capability：claim/release/resolve/close）。
  // dispute resolution 不是 enforcement truth——本 permission 不授予任何
  // 执法/处罚权（需要处罚必须单独走 canonical enforcement service）；
  // 刻意不进入 LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS（R1 冻结不动）。
  "dispute.review": "受理与处理租赁纠纷（claim/release/resolve/close）",
  // Phase 7G：纠纷证据窄读取（纯 read capability）。语义严格限定为
  // "仅访问 dispute-bound private evidence"（UploadedAsset.category == REPORT
  // 且 asset token 出现在该 dispute 的 evidencePhotos 内、campus 精确匹配）；
  // 同订单未绑定的其它 REPORT 资产（如 damage-claim 照片）恒 NO ACCESS。
  "dispute.evidence.read": "读取租赁纠纷绑定的私有证据材料（仅纠纷证据照片）",
  // Phase 7G：支持工单运营（mutation capability：claim/release/resolve/close）。
  // SupportTicket ≠ Dispute（两个独立 workflow 域）；刻意不进入
  // LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS（R1 冻结不动）。
  "support.manage": "处理支持工单（claim/release/resolve/close）",
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

/** 类型收窄：把任意字符串收窄为已知 PermissionKey（未知返回 null → 调用方 DENY）。 */
export function asPermissionKey(key: string): PermissionKey | null {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, key) ? (key as PermissionKey) : null;
}

/**
 * legacy full-admin 等价集合（Phase 7D R1 冻结）。
 *
 * baseline caf8c22 时代构成 legacy /admin 入口资格的 permission 全集——
 * 显式字面量数组，绝不从 PERMISSION_KEYS 派生。此后新增的 governance
 * capability（如 7D 的 enforcement.read）默认不进入本集合；扩列必须
 * 显式修改本文件并重新 review。
 *
 * 判定形式保持 permission-derived（一个 GLOBAL grant 覆盖本集合全量），
 * 禁止 role.key === "PLATFORM_ADMIN" 之类的角色名特判
 * （见 hasFullAdminSurfaceAccess）。
 */
export const LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS: PermissionKey[] = [
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
];

/**
 * requireAdmin 兼容桥的后台入口判定集合（Phase 7D R1：原为
 * `[...PERMISSION_KEYS]` 派生，现显式等于 LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS，
 * 行为与 baseline 逐字节等价）。
 *
 * 判定语义见 hasFullAdminSurfaceAccess：必须存在一个 GLOBAL grant 全量覆盖
 * 本集合（PLATFORM_ADMIN-like full authority），禁止 any-permission 拼接：
 * 细粒度 GLOBAL/CAMPUS 角色一律不构成旧超管。
 */
export const ADMIN_SURFACE_PERMISSION_KEYS: PermissionKey[] =
  LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS;
