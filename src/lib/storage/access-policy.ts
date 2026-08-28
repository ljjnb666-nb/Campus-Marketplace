import type { AssetAccess, AssetCategory } from "@prisma/client";
import { env } from "@/lib/env";
import type { UploadCategory } from "@/lib/upload";
import type { ObjectKeyAccess } from "@/lib/storage/object-key";

/**
 * 公私访问策略（单一事实来源）。
 * PUBLIC：可经公开对象 URL / CDN 直接访问。
 * PRIVATE：禁止永久公开 URL，只能走短时签名 URL + 业务鉴权。
 */
export const CATEGORY_ACCESS: Record<AssetCategory, AssetAccess> = {
  AVATAR: "PUBLIC",
  PRODUCT: "PUBLIC",
  RENTAL: "PUBLIC",
  SERVICE: "PUBLIC",
  VERIFICATION: "PRIVATE",
  HANDOVER: "PRIVATE",
  RETURN: "PRIVATE",
  REPORT: "PRIVATE",
};

/** 上传分类（小写表单值）→ 资源模型枚举 */
export const ASSET_CATEGORY_BY_UPLOAD_CATEGORY: Record<
  UploadCategory,
  AssetCategory
> = {
  avatar: "AVATAR",
  product: "PRODUCT",
  rental: "RENTAL",
  service: "SERVICE",
  verification: "VERIFICATION",
  handover: "HANDOVER",
  return: "RETURN",
  report: "REPORT",
};

/** 资源模型枚举 → 上传分类（查询 / 表单回显用） */
export const UPLOAD_CATEGORY_BY_ASSET_CATEGORY = Object.fromEntries(
  Object.entries(ASSET_CATEGORY_BY_UPLOAD_CATEGORY).map(([upload, asset]) => [
    asset,
    upload,
  ]),
) as Record<AssetCategory, UploadCategory>;

/** 资源枚举 → object key 中的业务目录段 */
export const CATEGORY_DIRECTORY: Record<AssetCategory, string> = {
  AVATAR: "avatars",
  PRODUCT: "products",
  RENTAL: "rentals",
  SERVICE: "services",
  VERIFICATION: "verification",
  HANDOVER: "handover",
  RETURN: "return",
  REPORT: "report",
};

export function assetAccessForCategory(category: AssetCategory): AssetAccess {
  return CATEGORY_ACCESS[category];
}

export function bucketForAccess(access: AssetAccess): string {
  return access === "PUBLIC" ? env.S3_BUCKET_PUBLIC : env.S3_BUCKET_PRIVATE;
}

export function keyAccessForAssetAccess(access: AssetAccess): ObjectKeyAccess {
  return access === "PUBLIC" ? "PUBLIC" : "PRIVATE";
}

/** 拼接公开对象的访问 URL（仅 PUBLIC 资源使用） */
export function buildPublicObjectUrl(objectKey: string): string {
  const base = env.PUBLIC_ASSET_BASE_URL.replace(/\/+$/, "");
  return `${base}/${objectKey}`;
}
