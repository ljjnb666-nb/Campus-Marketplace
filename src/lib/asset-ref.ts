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

/** 表单图片值合法性：http(s) 外链、历史 /uploads/ 路径、asset:<id> 引用 */
export function isManageableImageValue(value: string): boolean {
  return (
    /^https?:\/\//.test(value) ||
    isStoredImagePath(value) ||
    isAssetReference(value)
  );
}
