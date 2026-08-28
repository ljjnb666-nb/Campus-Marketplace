import type { AssetAccess, AssetCategory, Prisma, UploadedAsset } from "@prisma/client";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  ImageValidationError,
  processUploadedImage,
} from "@/lib/image-processing";
import {
  ASSET_CATEGORY_BY_UPLOAD_CATEGORY,
  assetAccessForCategory,
  bucketForAccess,
  buildObjectKey,
  buildPublicObjectUrl,
  CATEGORY_DIRECTORY,
  getStorage,
  keyAccessForAssetAccess,
} from "@/lib/storage";
import {
  buildAssetReference,
  isAssetReference,
  parseAssetReference,
} from "@/lib/asset-ref";
import { isUploadCategory, UPLOAD_LIMITS, type UploadCategory } from "@/lib/upload-limits";

export { buildAssetReference, isAssetReference, parseAssetReference };

/**
 * 上传资源服务：所有上传文件（公私）的唯一入口。
 *
 * 可靠性约定（与 STORAGE.md 对应）：
 * - 配额预留 = 单条条件 UPDATE（行锁串行化），并发上传无法突破总额；
 * - S3 上传失败 → 立即释放配额，不产生任何持久化痕迹；
 * - DB 登记失败 → 删除已上传对象 + 释放配额（compensation）；
 * - 对象删除走 PENDING_DELETE → DELETED 条件转移，配额释放 exactly-once；
 * - 重复删除 / cleanup 重跑均幂等。
 */

export type AssetServiceErrorCode =
  | "INVALID_CATEGORY"
  | "UNSUPPORTED_MIME"
  | "FILE_TOO_LARGE"
  | "TOO_MANY_FILES"
  | "QUOTA_EXCEEDED"
  | "STORAGE_UPLOAD_FAILED"
  | "ASSET_RECORD_FAILED"
  | "INVALID_ASSET_REFERENCE";

export class AssetServiceError extends Error {
  readonly code: AssetServiceErrorCode;
  readonly status: number;

  constructor(code: AssetServiceErrorCode, message: string, status = 400) {
    super(message);
    this.name = "AssetServiceError";
    this.code = code;
    this.status = status;
  }
}

export interface UploadedAssetResult {
  assetId: string;
  access: AssetAccess;
  /** 公开资源返回可直接访问的 URL；私有资源恒为 null（禁止永久公开 URL） */
  url: string | null;
  mimeType: string;
  sizeBytes: number;
}

function sanitizeOriginalFileName(name: string | undefined): string | null {
  if (!name) {
    return null;
  }
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return cleaned ? cleaned.slice(0, 200) : null;
}

/**
 * 扩展客户端（软删除拦截）上的 updateMany 返回 number | BatchPayload，
 * 统一归一化为计数。
 */
export function batchCount(result: number | { count: number }): number {
  return typeof result === "number" ? result : result.count;
}

/**
 * 将带扩展的 prisma 客户端收窄为事务客户端类型。
 * 运行时是同一对象，仅做类型适配（与 withTransaction 内部做法一致），
 * 避免联合类型触发扩展的类型深度超限。
 */
export function asAssetTx(client: typeof prisma): Prisma.TransactionClient {
  return client as unknown as Prisma.TransactionClient;
}

export function quotaBytes(): number {
  return env.STORAGE_QUOTA_MB * 1024 * 1024;
}

/**
 * 原子配额预留：`storageUsedBytes + size <= quota` 才更新。
 * 单条 UPDATE 在行锁下串行执行，两个并发请求不可能同时通过判定。
 * @returns 是否预留成功
 */
async function reserveQuotaBytes(userId: string, sizeBytes: number): Promise<boolean> {
  const reserved = await prisma.$executeRaw`
    UPDATE "User"
    SET "storageUsedBytes" = "storageUsedBytes" + ${sizeBytes}
    WHERE "id" = ${userId}
      AND "storageUsedBytes" + ${sizeBytes} <= ${quotaBytes()}
  `;
  return reserved > 0;
}

/**
 * 释放配额（下限 0，防重复释放导致负数）。
 * 调用方必须保证释放路径与预留一一对应（详见文件头注释）。
 */
async function releaseQuotaBytes(userId: string, sizeBytes: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "User"
    SET "storageUsedBytes" = GREATEST(0, "storageUsedBytes" - ${sizeBytes})
    WHERE "id" = ${userId}
  `;
}

export async function getStorageUsage(userId: string): Promise<{
  usedBytes: number;
  quotaBytes: number;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { storageUsedBytes: true },
  });
  return {
    usedBytes: user?.storageUsedBytes ?? 0,
    quotaBytes: quotaBytes(),
  };
}

/**
 * 上传图片资源：校验 → 重编码 → 配额预留 → 对象上传 → 资源登记。
 * 失败路径见文件头可靠性约定。
 */
export async function uploadImageAsset(params: {
  userId: string;
  category: UploadCategory;
  file: File;
}): Promise<UploadedAssetResult> {
  const startedAt = Date.now();
  const { userId, category, file } = params;

  if (!isUploadCategory(category)) {
    throw new AssetServiceError("INVALID_CATEGORY", "无效的上传分类");
  }

  const limits = UPLOAD_LIMITS[category];
  if (!(limits.allowedTypes as readonly string[]).includes(file.type)) {
    throw new AssetServiceError("UNSUPPORTED_MIME", "不支持的图片格式，仅支持JPG、PNG和WebP");
  }
  if (file.size > limits.maxSize) {
    const maxSizeMB = Math.floor(limits.maxSize / (1024 * 1024));
    throw new AssetServiceError("FILE_TOO_LARGE", `图片大小不能超过${maxSizeMB}MB`, 413);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const processed = await processUploadedImage(bytes);
  const sizeBytes = processed.buffer.byteLength;

  const reserved = await reserveQuotaBytes(userId, sizeBytes);
  if (!reserved) {
    logger.warn("上传配额不足，已拒绝", "asset-service", {
      operation: "upload",
      userId,
      category,
      sizeBytes,
    });
    throw new AssetServiceError(
      "QUOTA_EXCEEDED",
      "存储空间不足，请删除旧图片后再试",
      413,
    );
  }

  const assetCategory = ASSET_CATEGORY_BY_UPLOAD_CATEGORY[category];
  const access = assetAccessForCategory(assetCategory);
  const objectKey = buildObjectKey({
    access: keyAccessForAssetAccess(access),
    categoryDirectory: CATEGORY_DIRECTORY[assetCategory],
    userId,
    fileExtension: processed.format === "png" ? ".png" : ".webp",
  });
  const bucket = bucketForAccess(access);

  const storage = getStorage();
  try {
    await storage.putObject({
      bucket,
      objectKey,
      body: processed.buffer,
      contentType: processed.mimeType,
    });
  } catch (error) {
    // CASE A：S3 失败 → 释放配额，不留任何持久化痕迹
    await releaseQuotaBytes(userId, sizeBytes).catch((releaseError) => {
      logger.error("配额释放失败（S3 上传失败补偿）", "asset-service", {
        operation: "upload-compensate",
        userId,
        sizeBytes,
        error: releaseError,
      });
    });
    logger.error("对象存储上传失败", "asset-service", {
      operation: "upload",
      userId,
      category,
      sizeBytes,
      error,
    });
    throw new AssetServiceError("STORAGE_UPLOAD_FAILED", "图片上传失败，请稍后重试", 500);
  }

  let assetId: string;
  try {
    const asset = await prisma.uploadedAsset.create({
      data: {
        ownerId: userId,
        category: assetCategory,
        access,
        bucket,
        objectKey,
        mimeType: processed.mimeType,
        sizeBytes,
        width: processed.width,
        height: processed.height,
        originalFileName: sanitizeOriginalFileName(file.name),
        status: "UPLOADED",
      },
      select: { id: true },
    });
    assetId = asset.id;
  } catch (error) {
    // CASE B：DB 失败 → 删除已上传对象 + 释放配额
    await storage.deleteObject({ bucket, objectKey }).catch((deleteError) => {
      logger.error("补偿删除对象失败（DB 写入失败）", "asset-service", {
        operation: "upload-compensate",
        userId,
        sizeBytes,
        error: deleteError,
      });
    });
    await releaseQuotaBytes(userId, sizeBytes).catch((releaseError) => {
      logger.error("配额释放失败（DB 写入失败补偿）", "asset-service", {
        operation: "upload-compensate",
        userId,
        sizeBytes,
        error: releaseError,
      });
    });
    logger.error("资源登记失败", "asset-service", {
      operation: "upload",
      userId,
      category,
      sizeBytes,
      error,
    });
    throw new AssetServiceError("ASSET_RECORD_FAILED", "图片上传失败，请稍后重试", 500);
  }

  logger.info("图片资源已上传", "asset-service", {
    operation: "upload",
    assetId,
    userId,
    category,
    sizeBytes,
    durationMs: Date.now() - startedAt,
  });

  return {
    assetId,
    access,
    url: access === "PUBLIC" ? buildPublicObjectUrl(objectKey) : null,
    mimeType: processed.mimeType,
    sizeBytes,
  };
}

/** 图片内容校验错误统一转成用户可读 message（保留类型码供日志使用） */
export function isImageValidationError(error: unknown): error is ImageValidationError {
  return error instanceof ImageValidationError;
}

// ============================================================
// 业务绑定（attachment）
// ============================================================

export type AssetAttachTarget =
  | { type: "product"; id: string }
  | { type: "rentalListing"; id: string }
  | { type: "serviceListing"; id: string }
  | { type: "rentalOrder"; id: string }
  | { type: "verification"; id: string }
  | { type: "avatar" };

function attachTargetData(target: AssetAttachTarget): Record<string, string> {
  switch (target.type) {
    case "product":
      return { productId: target.id };
    case "rentalListing":
      return { rentalListingId: target.id };
    case "serviceListing":
      return { serviceListingId: target.id };
    case "rentalOrder":
      return { rentalOrderId: target.id };
    case "verification":
      return { verificationId: target.id };
    case "avatar":
      return {};
  }
}

type PrismaTx = Prisma.TransactionClient;

/**
 * 将用户自己的 UPLOADED 资源绑定到业务实体（条件转移，幂等）。
 * 非本人 / 已绑定 / 已删除的资源不会被重复绑定。
 */
export async function attachAssetsToEntity(
  tx: PrismaTx,
  params: { ownerId: string; assetIds: string[]; target: AssetAttachTarget },
): Promise<number> {
  const uniqueIds = [...new Set(params.assetIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) {
    return 0;
  }

  let attached = 0;
  for (const assetId of uniqueIds) {
    const claimed = await tx.uploadedAsset.updateMany({
      where: { id: assetId, ownerId: params.ownerId, status: "UPLOADED" },
      data: { status: "ATTACHED", attachedAt: new Date(), ...attachTargetData(params.target) },
    });
    attached += batchCount(claimed);
  }
  return attached;
}

function canonicalAssetValue(asset: UploadedAsset): string {
  return asset.access === "PUBLIC"
    ? buildPublicObjectUrl(asset.objectKey)
    : buildAssetReference(asset.id);
}

/**
 * 解析表单图片 token 列表：
 * - `asset:<id>` → 校验归属并绑定到业务实体，返回规范化值（公开 URL / asset 引用）
 * - 其余（http(s) 外链、历史 /uploads/ 路径）原样保留，由 zod 层做格式校验
 *
 * 顺序保持不变（业务侧 sortOrder / 封面顺序依赖输入顺序）。
 */
export async function resolveImageTokens(params: {
  ownerId: string;
  tokens: string[];
  target: AssetAttachTarget;
  tx?: PrismaTx;
}): Promise<string[]> {
  const { ownerId, tokens, target } = params;
  const tx = params.tx ?? asAssetTx(prisma);
  const resolved: string[] = [];

  for (const rawToken of tokens) {
    const token = rawToken.trim();
    if (!token) {
      continue;
    }

    const assetId = parseAssetReference(token);
    if (!assetId) {
      resolved.push(token);
      continue;
    }

    const asset = await tx.uploadedAsset.findFirst({
      where: { id: assetId, ownerId },
    });
    if (!asset || asset.status === "DELETED" || asset.status === "PENDING_DELETE") {
      throw new AssetServiceError("INVALID_ASSET_REFERENCE", "图片资源不存在或已失效");
    }

    if (asset.status === "UPLOADED") {
      await attachAssetsToEntity(tx, {
        ownerId,
        assetIds: [asset.id],
        target,
      });
    }
    resolved.push(canonicalAssetValue(asset));
  }

  return resolved;
}

/**
 * 解析单个图片 token（封面 / 头像场景），空值返回 null。
 */
export async function resolveSingleImageToken(params: {
  ownerId: string;
  token: string;
  target: AssetAttachTarget;
  tx?: PrismaTx;
}): Promise<string | null> {
  const trimmed = params.token.trim();
  if (!trimmed) {
    return null;
  }
  const [resolved] = await resolveImageTokens({ ...params, tokens: [trimmed] });
  return resolved ?? null;
}

// ============================================================
// 删除与生命周期
// ============================================================

/** 标记资源待删除（幂等；重复标记返回 false） */
export async function markAssetPendingDelete(assetId: string): Promise<boolean> {
  const marked = await prisma.uploadedAsset.updateMany({
    where: { id: assetId, status: { in: ["UPLOADED", "ATTACHED"] } },
    data: { status: "PENDING_DELETE" },
  });
  return batchCount(marked) > 0;
}

/**
 * 物理删除 PENDING_DELETE 资源的对象并完成状态转移 + 配额释放。
 * 条件转移（PENDING_DELETE → DELETED）保证配额释放 exactly-once；
 * 对象删除失败时保留 PENDING_DELETE，由 cleanup 重试。
 */
export async function purgePendingDeleteAsset(asset: {
  id: string;
  ownerId: string;
  bucket: string;
  objectKey: string;
  sizeBytes: number;
}): Promise<boolean> {
  const storage = getStorage();
  try {
    await storage.deleteObject({ bucket: asset.bucket, objectKey: asset.objectKey });
  } catch (error) {
    logger.error("对象删除失败，保留待重试", "asset-service", {
      operation: "purge",
      assetId: asset.id,
      userId: asset.ownerId,
      error,
    });
    return false;
  }

  const completed = await prisma.uploadedAsset.updateMany({
    where: { id: asset.id, status: "PENDING_DELETE" },
    data: { status: "DELETED", expiresAt: null },
  });

  if (batchCount(completed) > 0) {
    await releaseQuotaBytes(asset.ownerId, asset.sizeBytes);
    logger.info("资源已删除", "asset-service", {
      operation: "purge",
      assetId: asset.id,
      userId: asset.ownerId,
      sizeBytes: asset.sizeBytes,
    });
  }
  return true;
}

/** 标记 + 物理删除一条资源（业务删除路径的完整入口） */
export async function deleteAssetCompletely(assetId: string): Promise<boolean> {
  const marked = await markAssetPendingDelete(assetId);
  if (!marked) {
    return false;
  }
  const asset = await prisma.uploadedAsset.findUnique({
    where: { id: assetId },
    select: { id: true, ownerId: true, bucket: true, objectKey: true, sizeBytes: true },
  });
  if (!asset) {
    return false;
  }
  return purgePendingDeleteAsset(asset);
}

function objectKeyFromPublicUrl(url: string): string | null {
  const base = env.PUBLIC_ASSET_BASE_URL.replace(/\/+$/, "");
  if (!url.startsWith(`${base}/`)) {
    return null;
  }
  const objectKey = url.slice(base.length + 1);
  return /^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(objectKey) ? objectKey : null;
}

/**
 * 按业务字段中保存的图片值（公开 URL 或 asset: 引用）标记对应资源待删除。
 * 用于编辑业务实体时替换/移除旧图、软删除业务实体等场景。
 */
export async function markAssetsForValuesPendingDelete(
  ownerId: string,
  values: string[],
): Promise<number> {
  const assetIds = new Set<string>();
  const objectKeys: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const assetId = parseAssetReference(trimmed);
    if (assetId) {
      assetIds.add(assetId);
      continue;
    }
    const objectKey = objectKeyFromPublicUrl(trimmed);
    if (objectKey) {
      objectKeys.push(objectKey);
    }
  }

  if (assetIds.size === 0 && objectKeys.length === 0) {
    return 0;
  }

  const result = await prisma.uploadedAsset.updateMany({
    where: {
      ownerId,
      status: { in: ["UPLOADED", "ATTACHED"] },
      OR: [
        ...(assetIds.size > 0 ? [{ id: { in: [...assetIds] } }] : []),
        ...(objectKeys.length > 0 ? [{ objectKey: { in: objectKeys } }] : []),
      ],
    },
    data: { status: "PENDING_DELETE" },
  });
  return batchCount(result);
}

/** 敏感（认证）资源设置保留期截止时间；到期后 cleanup 删除对象但保留认证结论 */
export async function applyVerificationAssetRetention(
  tx: PrismaTx,
  verificationId: string,
  now = new Date(),
): Promise<number> {
  const expiresAt = new Date(
    now.getTime() + env.VERIFICATION_ASSET_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const result = await tx.uploadedAsset.updateMany({
    where: { verificationId, status: { in: ["UPLOADED", "ATTACHED"] } },
    data: { expiresAt },
  });
  return batchCount(result);
}

// ============================================================
// 私有资源访问授权
// ============================================================

export type PrivateAssetAccessResult =
  | { ok: true; asset: UploadedAsset & { rentalOrder: { renterId: string; ownerId: string } | null } }
  | { ok: false; reason: "not_found" | "not_private" | "expired" | "forbidden" };

/**
 * 私有资源访问授权：
 * - VERIFICATION：仅资源本人与 ADMIN
 * - HANDOVER / RETURN / REPORT：资源本人、对应租赁订单的租客/出租者、ADMIN
 * - 已删除/待删除 → not_found；已过保留期 → expired
 */
export async function resolvePrivateAssetAccess(
  assetId: string,
  user: { id: string; role: string },
  now = new Date(),
): Promise<PrivateAssetAccessResult> {
  const asset = await prisma.uploadedAsset.findFirst({
    where: { id: assetId },
    include: {
      rentalOrder: { select: { renterId: true, ownerId: true } },
    },
  });

  if (!asset || asset.status === "DELETED" || asset.status === "PENDING_DELETE") {
    return { ok: false, reason: "not_found" };
  }
  if (asset.access === "PUBLIC") {
    return { ok: false, reason: "not_private" };
  }
  if (asset.expiresAt && asset.expiresAt < now) {
    return { ok: false, reason: "expired" };
  }

  const isAdmin = user.role === "ADMIN";
  if (isAdmin || asset.ownerId === user.id) {
    return { ok: true, asset };
  }

  const order = asset.rentalOrder;
  const orderParticipant =
    order !== null && (order.renterId === user.id || order.ownerId === user.id);

  const categoryAllowsOrderParticipants: AssetCategory[] = ["HANDOVER", "RETURN", "REPORT"];
  if (orderParticipant && categoryAllowsOrderParticipants.includes(asset.category)) {
    return { ok: true, asset };
  }

  return { ok: false, reason: "forbidden" };
}

/** 生成私有资源短时签名读 URL（TTL 来自 env，默认 5 分钟） */
export async function createPrivateAssetSignedUrl(asset: {
  bucket: string;
  objectKey: string;
}): Promise<{ url: string; expiresIn: number }> {
  const expiresIn = env.PRIVATE_SIGNED_URL_TTL_SECONDS;
  const url = await getStorage().getSignedReadUrl(
    { bucket: asset.bucket, objectKey: asset.objectKey },
    expiresIn,
  );
  return { url, expiresIn };
}

/**
 * 解析公开资源的访问 URL。
 * 仅接受存活的 PUBLIC 资源；私有/已删除资源返回 null（调用方按 404 处理）。
 */
export async function resolvePublicAssetUrl(assetId: string): Promise<string | null> {
  const asset = await prisma.uploadedAsset.findFirst({
    where: {
      id: assetId,
      access: "PUBLIC",
      status: { in: ["UPLOADED", "ATTACHED"] },
    },
    select: { objectKey: true },
  });
  return asset ? buildPublicObjectUrl(asset.objectKey) : null;
}
