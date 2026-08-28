/**
 * 上传分类与限制常量（纯数据模块，无服务端依赖）。
 * 供 upload 门面与 asset-service 共享，避免两者互相引用形成循环依赖。
 */

export const UPLOAD_LIMITS = {
  avatar: {
    maxSize: 5 * 1024 * 1024, // 5MB
    maxCount: 1,
    allowedTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  product: {
    maxSize: 10 * 1024 * 1024, // 10MB
    maxCount: 9,
    allowedTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  rental: {
    maxSize: 10 * 1024 * 1024, // 10MB
    maxCount: 9,
    allowedTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  service: {
    maxSize: 10 * 1024 * 1024, // 10MB
    maxCount: 5,
    allowedTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  verification: {
    maxSize: 5 * 1024 * 1024, // 5MB
    maxCount: 2,
    allowedTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  handover: {
    maxSize: 10 * 1024 * 1024, // 10MB
    maxCount: 5,
    allowedTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  return: {
    maxSize: 10 * 1024 * 1024, // 10MB
    maxCount: 5,
    allowedTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  report: {
    maxSize: 10 * 1024 * 1024, // 10MB
    maxCount: 5,
    allowedTypes: ["image/jpeg", "image/png", "image/webp"],
  },
} as const;

export type UploadCategory = keyof typeof UPLOAD_LIMITS;

// 显式白名单：直接用 UPLOAD_LIMITS[category] 索引会被 "constructor" 等
// Object.prototype 上的属性命中，绕过空值检查
const UPLOAD_CATEGORIES = new Set<string>(Object.keys(UPLOAD_LIMITS));

export function isUploadCategory(value: string): value is UploadCategory {
  return UPLOAD_CATEGORIES.has(value);
}

type AllowedMimeType = "image/jpeg" | "image/png" | "image/webp";

export function isAcceptedImageFile(
  file: File | null | undefined,
  category: UploadCategory = "product",
): boolean {
  if (!file || file.size === 0) {
    return false;
  }

  const limits = UPLOAD_LIMITS[category];

  if (!limits.allowedTypes.includes(file.type as AllowedMimeType)) {
    return false;
  }

  if (file.size > limits.maxSize) {
    return false;
  }

  return true;
}
