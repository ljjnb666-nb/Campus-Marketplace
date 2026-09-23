/**
 * 图片值引用的纯工具函数（无任何服务端依赖，客户端组件可安全引用）。
 *
 * 业务表图片字段允许三种值：
 * - http(s) 外链 / CDN URL
 * - 历史 /uploads/ 本地静态路径（存量数据读取兼容）
 * - `asset:<assetId>` —— 新上传体系的资源引用（私有资源唯一合法形态）
 */

export const ASSET_REFERENCE_PREFIX = "asset:";

const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function buildAssetReference(assetId: string): string {
  return `${ASSET_REFERENCE_PREFIX}${assetId}`;
}

export function isAssetReference(value: string): boolean {
  return (
    value.startsWith(ASSET_REFERENCE_PREFIX) && value.length > ASSET_REFERENCE_PREFIX.length
  );
}

export function parseAssetReference(value: string): string | null {
  if (!isAssetReference(value)) {
    return null;
  }
  const assetId = value.slice(ASSET_REFERENCE_PREFIX.length);
  return ASSET_ID_PATTERN.test(assetId) ? assetId : null;
}

/** 历史 /uploads/ 本地静态路径（存量数据读取兼容；新上传不再产生该前缀） */
export function isStoredImagePath(value: string): boolean {
  return value.startsWith("/uploads/");
}

/**
 * 表单图片值合法性：http(s) 外链、历史 /uploads/ 路径、严格合法的 asset:<id> 引用。
 * 以 asset: 开头但格式非法的值（asset:..、asset:***、asset:%2f、超长等）一律拒绝，
 * 不得作为普通 token 透传进数据库。
 */
export function isManageableImageValue(value: string): boolean {
  if (value.startsWith(ASSET_REFERENCE_PREFIX)) {
    return parseAssetReference(value) !== null;
  }
  return /^https?:\/\//.test(value) || isStoredImagePath(value);
}

// ============================================================
// RB-01：认证证据引用分类（runtime fail-closed 的单一判定点）
// ============================================================

/** UserVerification.studentCardImage 的受控引用形态（唯一可渲染形态） */
export const CONTROLLED_EVIDENCE = "CONTROLLED_ASSET" as const;
export const LEGACY_LOCAL_EVIDENCE = "LEGACY_LOCAL" as const;
export const LEGACY_EXTERNAL_EVIDENCE = "LEGACY_EXTERNAL" as const;
export const UNKNOWN_EVIDENCE = "UNKNOWN" as const;
export const UNAVAILABLE_EVIDENCE = "UNAVAILABLE" as const;

export type VerificationEvidenceReferenceKind =
  | typeof CONTROLLED_EVIDENCE
  | typeof LEGACY_LOCAL_EVIDENCE
  | typeof LEGACY_EXTERNAL_EVIDENCE
  | typeof UNKNOWN_EVIDENCE
  | typeof UNAVAILABLE_EVIDENCE;

/**
 * 认证证据引用分类（RB-01 Repair 2）：
 * - CONTROLLED_ASSET：严格合法的 asset:<id> —— 唯一允许经受保护路由查看的形态
 * - LEGACY_LOCAL：历史 /uploads/ 直链（存量兼容形态，禁止渲染为链接）
 * - LEGACY_EXTERNAL：http(s) 外链（禁止渲染为链接）
 * - UNKNOWN：其它任意字符串（含 "erased" 注销哨兵、"legacy" 历史哨兵、
 *   javascript: 等恶意/畸形串；一律 fail closed）
 * - UNAVAILABLE：空值（迁移清空 / 未提交材料）
 *
 * 认证证据不得再散落 startsWith("asset:") 判断——渲染、读模型、
 * 提交校验必须经由本函数，防止 legacy 直链绕过私有资产模型再次发生。
 */
export function parseVerificationEvidenceReference(value: string | null | undefined): VerificationEvidenceReferenceKind {
  if (!value) {
    return UNAVAILABLE_EVIDENCE;
  }
  if (value.startsWith(ASSET_REFERENCE_PREFIX)) {
    // asset: 前缀但格式非法（含 "asset:" 纯前缀）按 UNKNOWN fail closed，
    // 绝不回退任何 raw 兼容渲染
    return parseAssetReference(value) !== null ? CONTROLLED_EVIDENCE : UNKNOWN_EVIDENCE;
  }
  if (isStoredImagePath(value)) {
    return LEGACY_LOCAL_EVIDENCE;
  }
  if (/^https?:\/\//.test(value)) {
    return LEGACY_EXTERNAL_EVIDENCE;
  }
  return UNKNOWN_EVIDENCE;
}

/** 是否为可经受保护路由查看的受控认证证据引用 */
export function isControlledVerificationEvidence(value: string | null | undefined): boolean {
  return parseVerificationEvidenceReference(value) === CONTROLLED_EVIDENCE;
}
