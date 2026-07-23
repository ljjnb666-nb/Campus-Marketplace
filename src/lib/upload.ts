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

  const limits = UPLOAD_LIMITS[category];

  if (!limits.allowedTypes.includes(file.type as AllowedMimeType)) {
    throw new Error("不支持的图片格式，仅支持JPG、PNG和WebP");
  }

  if (file.size > limits.maxSize) {
    const maxSizeMB = Math.floor(limits.maxSize / (1024 * 1024));
    throw new Error(`图片大小不能超过${maxSizeMB}MB`);
  }

  const targetDirectory = path.join(resolveUploadRoot(), `${category}s`);
  const extension = resolveExtension(file);
  const fileName = `${Date.now()}-${randomUUID()}${extension}`;
  const outputPath = path.join(targetDirectory, fileName);

  await mkdir(targetDirectory, { recursive: true });
  await writeFile(outputPath, Buffer.from(await file.arrayBuffer()));

  return `/uploads/${category}/${fileName}`.replace(/\\/g, "/");
}

export function getUploadErrorMessage(category: UploadCategory): string {
  const limits = UPLOAD_LIMITS[category];
  const maxSizeMB = Math.floor(limits.maxSize / (1024 * 1024));
  return `仅支持JPG、PNG和WebP格式，单张图片不超过${maxSizeMB}MB`;
}
