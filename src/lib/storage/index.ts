import type { StorageClient } from "@/lib/storage/types";
import { S3Storage } from "@/lib/storage/s3-storage";

/**
 * 存储入口：进程内单例，便于测试注入替换实现。
 * 业务代码统一 `import { getStorage } from "@/lib/storage"`，
 * React 组件/页面禁止直接调用本模块（由 API/Action/Service 层封装）。
 */

let storageInstance: StorageClient | null = null;

declare global {
  // 热重载下避免重复创建 S3Client
  var __campusStorage: StorageClient | undefined;
}

export function getStorage(): StorageClient {
  if (storageInstance) {
    return storageInstance;
  }
  if (process.env.NODE_ENV !== "production" && globalThis.__campusStorage) {
    storageInstance = globalThis.__campusStorage;
    return storageInstance;
  }
  storageInstance = new S3Storage();
  if (process.env.NODE_ENV !== "production") {
    globalThis.__campusStorage = storageInstance;
  }
  return storageInstance;
}

/** 测试专用：注入替身实现 */
export function setStorageForTests(storage: StorageClient | null): void {
  storageInstance = storage;
  globalThis.__campusStorage = storage ?? undefined;
}

export type { StorageClient, ObjectRef, ObjectMetadata, PutObjectInput } from "@/lib/storage/types";
export { buildObjectKey, assertSafeObjectKey, isWellFormedObjectKey } from "@/lib/storage/object-key";
export {
  CATEGORY_ACCESS,
  ASSET_CATEGORY_BY_UPLOAD_CATEGORY,
  UPLOAD_CATEGORY_BY_ASSET_CATEGORY,
  CATEGORY_DIRECTORY,
  assetAccessForCategory,
  bucketForAccess,
  keyAccessForAssetAccess,
  buildPublicObjectUrl,
} from "@/lib/storage/access-policy";
