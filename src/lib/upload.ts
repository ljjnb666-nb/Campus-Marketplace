/**
 * 上传门面：保留表单/校验层依赖的同步辅助函数与限制常量，
 * 实际上传全部委托给 asset-service（S3 兼容对象存储 + 配额 + 资源登记）。
 *
 * 生产环境禁止任何本地磁盘写入（mkdir/writeFile/public/uploads 已移除）；
 * 历史 /uploads/ 路径仅作为读取兼容（validator 放行存量数据）。
 */

export {
  ASSET_REFERENCE_PREFIX,
  buildAssetReference,
  isAssetReference,
  parseAssetReference,
  isStoredImagePath,
  isManageableImageValue,
} from "@/lib/asset-ref";

export {
  uploadImageAsset,
  getStorageUsage,
  resolveImageTokens,
  resolveSingleImageToken,
  attachAssetsToEntity,
  markAssetPendingDelete,
  deleteAssetCompletely,
  markAssetsForValuesPendingDelete,
  applyVerificationAssetRetention,
  resolvePrivateAssetAccess,
  createPrivateAssetSignedUrl,
  resolvePublicAssetUrl,
  AssetServiceError,
  isImageValidationError,
  asAssetTx,
  batchCount,
  type UploadedAssetResult,
  type AssetAttachTarget,
} from "@/lib/asset-service";

import { buildAssetReference } from "@/lib/asset-ref";
import { uploadImageAsset } from "@/lib/asset-service";
import { UPLOAD_LIMITS } from "@/lib/upload-limits";

export { UPLOAD_LIMITS, isUploadCategory, isAcceptedImageFile } from "@/lib/upload-limits";
export type { UploadCategory } from "@/lib/upload-limits";

/**
 * 上传单张图片（对象存储）。
 * - 公开分类返回可直接访问的公开 URL
 * - 私有分类返回 `asset:<assetId>` 引用（禁止永久公开 URL，访问走签名接口）
 * - file 为空时返回 null（保持既有"未提供图片"语义）
 */
export async function saveUploadedImage(
  file: File | null | undefined,
  category: import("@/lib/upload-limits").UploadCategory,
  ownerId: string,
): Promise<string | null> {
  if (!file || file.size === 0) {
    return null;
  }

  const result = await uploadImageAsset({ userId: ownerId, category, file });
  return result.access === "PUBLIC" && result.url ? result.url : buildAssetReference(result.assetId);
}

export function getUploadErrorMessage(
  category: import("@/lib/upload-limits").UploadCategory,
): string {
  const limits = UPLOAD_LIMITS[category];
  const maxSizeMB = Math.floor(limits.maxSize / (1024 * 1024));
  return `仅支持JPG、PNG和WebP格式，单张图片不超过${maxSizeMB}MB`;
}
