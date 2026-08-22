import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

const DEFAULT_EXTENSION = ".jpg";

type AllowedMimeType = "image/jpeg" | "image/png" | "image/webp";

const MIME_EXTENSION_MAP: Record<AllowedMimeType, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

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

function hasValidImageMagicBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 12) {
    return false;
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return true;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return true;
  }

  // WebP: "RIFF" + 4 字节长度 + "WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return true;
  }

  return false;
}

function resolveUploadRoot() {
  return path.resolve(process.cwd(), env.UPLOAD_DIR);
}

function resolveExtension(file: File) {
  const mimeExtension = MIME_EXTENSION_MAP[file.type as AllowedMimeType];
  if (mimeExtension) {
    return mimeExtension;
  }

  const nameExtension = path.extname(file.name).toLowerCase();
  if (nameExtension && Object.values(MIME_EXTENSION_MAP).includes(nameExtension)) {
    return nameExtension;
  }

  return DEFAULT_EXTENSION;
}

export function isAcceptedImageFile(file: File | null | undefined, category: UploadCategory = "product"): boolean {
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

export function isStoredImagePath(value: string): boolean {
  return value.startsWith("/uploads/");
}

export async function saveUploadedImage(
  file: File | null | undefined,
  category: UploadCategory = "product",
): Promise<string | null> {
  if (!file || file.size === 0) {
    return null;
  }

  if (!isUploadCategory(category)) {
    throw new Error("无效的上传分类");
  }

  const limits = UPLOAD_LIMITS[category];

  if (!limits.allowedTypes.includes(file.type as AllowedMimeType)) {
    throw new Error("不支持的图片格式，仅支持JPG、PNG和WebP");
  }

  if (file.size > limits.maxSize) {
    const maxSizeMB = Math.floor(limits.maxSize / (1024 * 1024));
    throw new Error(`图片大小不能超过${maxSizeMB}MB`);
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());

  // Content-Type 由客户端声明可伪造，校验文件头防止伪装成图片存储任意内容
  if (!hasValidImageMagicBytes(fileBytes)) {
    throw new Error("文件内容不是有效的图片，仅支持JPG、PNG和WebP");
  }

  const targetDirectory = path.join(resolveUploadRoot(), `${category}s`);
  const extension = resolveExtension(file);
  const fileName = `${Date.now()}-${randomUUID()}${extension}`;
  const outputPath = path.join(targetDirectory, fileName);

  await mkdir(targetDirectory, { recursive: true });
  await writeFile(outputPath, Buffer.from(fileBytes));

  return `/uploads/${category}/${fileName}`.replace(/\\/g, "/");
}

export function getUploadErrorMessage(category: UploadCategory): string {
  const limits = UPLOAD_LIMITS[category];
  const maxSizeMB = Math.floor(limits.maxSize / (1024 * 1024));
  return `仅支持JPG、PNG和WebP格式，单张图片不超过${maxSizeMB}MB`;
}
