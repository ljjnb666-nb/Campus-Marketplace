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
 * 上传状态机（可恢复，配额与 DB 记录永不脱钩）：
 *
 *   [事务 T1: 原子预留配额 + 创建行(status=UPLOADING)]  ← 任何崩溃都一起回滚/留存
 *     ↓ S3 PUT（外部副作用）
 *   [UPLOADED]（条件转移）
 *     ↓ attach
 *   [ATTACHED] ⇄（编辑复用，仅同实体幂等）
 *     ↓ 标记
 *   [PENDING_DELETE] → S3 DeleteObject（幂等）
 *     ↓ [事务 T2: 条件转移 DELETED + 同事务配额减额]（exactly-once）
 *   [DELETED]
 *
 * 崩溃恢复（cleanup）：
 * - stale UPLOADING（TTL 24h）：对象可能存在也可能不存在 → deleteObject（幂等）
 *   → PENDING_DELETE → T2 释放
 * - 任意 PENDING_DELETE：重复执行安全，两个 worker 并发只有一个完成转移与减额
 */

export type AssetServiceErrorCode =
  | "INVALID_CATEGORY"
  | "UNSUPPORTED_MIME"
  | "FILE_TOO_LARGE"
  | "TOO_MANY_FILES"
  | "QUOTA_EXCEEDED"
  | "STORAGE_UPLOAD_FAILED"
  | "ASSET_RECORD_FAILED"
  | "INVALID_ASSET_REFERENCE"
  | "ASSET_CATEGORY_MISMATCH"
  | "ASSET_ALREADY_ATTACHED";

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

/** 对象 Cache-Control 策略：按访问级别显式给定，存储层不做猜测 */
export const PUBLIC_OBJECT_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const PRIVATE_OBJECT_CACHE_CONTROL = "private, no-store";

/**
 * AssetCategory ↔ 业务绑定目标 的唯一兼容映射。
 * 任何资产只能绑定到其语义对应的实体类型，跨类使用一律拒绝。
 */
export const ATTACH_COMPATIBILITY: Record<AssetCategory, AssetAttachTarget["type"][]> = {
  AVATAR: ["avatar"],
  PRODUCT: ["product"],
  RENTAL: ["rentalListing"],
  SERVICE: ["serviceListing"],
  VERIFICATION: ["verification"],
  HANDOVER: ["rentalOrder"],
  RETURN: ["rentalOrder"],
  REPORT: ["rentalOrder"],
};

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
async function reserveQuotaBytes(
  tx: Prisma.TransactionClient,
  userId: string,
  sizeBytes: number,
): Promise<boolean> {
  const reserved = await tx.$executeRaw`
    UPDATE "User"
    SET "storageUsedBytes" = "storageUsedBytes" + ${sizeBytes}
    WHERE "id" = ${userId}
      AND "storageUsedBytes" + ${sizeBytes} <= ${quotaBytes()}
  `;
  return reserved > 0;
}

/**
 * 释放配额（下限 0，防重复释放导致负数）。
 * 仅在与状态转移相同的显式事务内调用，保证 exactly-once。
 */
async function releaseQuotaBytes(
  tx: Prisma.TransactionClient,
  userId: string,
  sizeBytes: number,
): Promise<void> {
  await tx.$executeRaw`
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

// ============================================================
// 上传（可恢复状态机）
// ============================================================

/**
 * 上传图片资源：
 * 校验 → 重编码 → [T1: 配额预留 + UPLOADING 行] → S3 PUT → UPLOADED。
 *
 * T1 事务性：预留与行创建同生共死——行创建失败则预留一并回滚；
 * 进程在 T1 后任意时刻崩溃，UPLOADING 行都在，cleanup 可恢复。
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

  const assetCategory = ASSET_CATEGORY_BY_UPLOAD_CATEGORY[category];
  const access = assetAccessForCategory(assetCategory);
  const objectKey = buildObjectKey({
    access: keyAccessForAssetAccess(access),
    categoryDirectory: CATEGORY_DIRECTORY[assetCategory],
    userId,
    fileExtension: processed.format === "png" ? ".png" : ".webp",
  });
  const bucket = bucketForAccess(access);
  const cacheControl =
    access === "PUBLIC" ? PUBLIC_OBJECT_CACHE_CONTROL : PRIVATE_OBJECT_CACHE_CONTROL;

  // T1：配额预留与可恢复记录同一事务提交——不存在"已预留但无记录"的窗口
  let assetId: string;
  try {
    const created = await prisma.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as Prisma.TransactionClient;
      const reserved = await reserveQuotaBytes(tx, userId, sizeBytes);
      if (!reserved) {
        throw new AssetServiceError(
          "QUOTA_EXCEEDED",
          "存储空间不足，请删除旧图片后再试",
          413,
        );
      }
      return tx.uploadedAsset.create({
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
          status: "UPLOADING",
        },
        select: { id: true },
      });
    });
    assetId = created.id;
  } catch (error) {
    if (error instanceof AssetServiceError) throw error;
    logger.error("资源登记事务失败（配额已一并回滚）", "asset-service", {
      operation: "upload",
      userId,
      category,
      sizeBytes,
      error,
    });
    throw new AssetServiceError("ASSET_RECORD_FAILED", "图片上传失败，请稍后重试", 500);
  }

  const storage = getStorage();
  try {
    await storage.putObject({
      bucket,
      objectKey,
      body: processed.buffer,
      contentType: processed.mimeType,
      cacheControl,
    });
  } catch (error) {
    // CASE A：S3 失败 → 尽力补偿（删行 + 释放配额，同一事务）；
    // 补偿失败时行保持 UPLOADING，由 cleanup 按 stale 恢复
    await abandonUploadingAsset(assetId, userId, sizeBytes).catch((abandonError) => {
      logger.error("UPLOADING 补偿失败，留待 cleanup 恢复", "asset-service", {
        operation: "upload-compensate",
        assetId,
        userId,
        sizeBytes,
        error: abandonError,
      });
    });
    logger.error("对象存储上传失败", "asset-service", {
      operation: "upload",
      assetId,
      userId,
      category,
      sizeBytes,
      error,
    });
    throw new AssetServiceError("STORAGE_UPLOAD_FAILED", "图片上传失败，请稍后重试", 500);
  }

  // PUT 成功：条件转移 UPLOADING → UPLOADED。
  // 转移失败（DB 故障）：行停留 UPLOADING，cleanup 会删除对象并释放配额（用户重试即可）
  const uploaded = await prisma.uploadedAsset.updateMany({
    where: { id: assetId, status: "UPLOADING" },
    data: { status: "UPLOADED" },
  });
  if (batchCount(uploaded) !== 1) {
    logger.error("UPLOADED 状态转移未命中，资源将由 cleanup 回收", "asset-service", {
      operation: "upload",
      assetId,
      userId,
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

/** 放弃一条 UPLOADING 资源：单事务内删行 + 释放配额（上传失败的即时补偿） */
async function abandonUploadingAsset(
  assetId: string,
  userId: string,
  sizeBytes: number,
): Promise<void> {
  await prisma.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as Prisma.TransactionClient;
    const removed = await tx.uploadedAsset.deleteMany({
      where: { id: assetId, status: "UPLOADING" },
    });
    if (batchCount(removed) === 1) {
      await releaseQuotaBytes(tx, userId, sizeBytes);
    }
  });
}

/** 图片内容校验错误统一转成用户可读 message（保留类型码供日志使用） */
export function isImageValidationError(error: unknown): error is ImageValidationError {
  return error instanceof ImageValidationError;
}

// ============================================================
// 业务绑定（attachment）与兼容性校验
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

/** 资产类别是否允许绑定到该目标类型（唯一映射，见 ATTACH_COMPATIBILITY） */
export function isAssetCompatibleWithTarget(
  category: AssetCategory,
  target: AssetAttachTarget,
): boolean {
  return ATTACH_COMPATIBILITY[category]?.includes(target.type) ?? false;
}

/**
 * 已 ATTACHED 的资产是否绑定在"同一个目标实体"上（幂等复用的唯一许可）。
 * avatar 无独立实体：同 owner 的 ATTACHED avatar 视为同目标。
 */
export function isSameAttachment(
  asset: Pick<
    UploadedAsset,
    | "category"
    | "productId"
    | "rentalListingId"
    | "serviceListingId"
    | "rentalOrderId"
    | "verificationId"
  >,
  target: AssetAttachTarget,
): boolean {
  switch (target.type) {
    case "avatar":
      return asset.category === "AVATAR";
    case "product":
      return asset.productId === target.id;
    case "rentalListing":
      return asset.rentalListingId === target.id;
    case "serviceListing":
      return asset.serviceListingId === target.id;
    case "rentalOrder":
      return asset.rentalOrderId === target.id;
    case "verification":
      return asset.verificationId === target.id;
  }
}

type PrismaTx = Prisma.TransactionClient;

/**
 * 校验资产可否用于目标（owner / category / access / 状态 / 当前绑定）。
 * 抛出带稳定错误码的 AssetServiceError。
 */
function assertAssetUsableForTarget(
  asset: UploadedAsset,
  ownerId: string,
  target: AssetAttachTarget,
): void {
  if (!isAssetCompatibleWithTarget(asset.category, target)) {
    throw new AssetServiceError(
      "ASSET_CATEGORY_MISMATCH",
      "图片类型与用途不匹配，请重新上传",
    );
  }
  if (asset.status === "ATTACHED") {
    if (!isSameAttachment(asset, target)) {
      // 同 owner 也不允许跨实体复用（含 PRIVATE 资产跨实体转移）
      throw new AssetServiceError(
        "ASSET_ALREADY_ATTACHED",
        "图片已被其他内容使用，请重新上传",
      );
    }
    return; // 同实体幂等复用
  }
}

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
 * - `asset:<id>` → 严格解析（前缀匹配但格式非法直接拒绝），校验
 *   owner/category/access/状态/当前绑定 后绑定到目标，返回规范化值
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

    if (token.startsWith("asset:")) {
      // 以 asset: 开头的一律按严格引用处理：解析失败即拒绝，绝不透传进 DB
      const assetId = parseAssetReference(token);
      if (!assetId) {
        throw new AssetServiceError("INVALID_ASSET_REFERENCE", "图片引用格式不正确");
      }

      const asset = await tx.uploadedAsset.findFirst({
        where: { id: assetId, ownerId },
      });
      if (
        !asset ||
        (asset.status !== "UPLOADED" && asset.status !== "ATTACHED")
      ) {
        throw new AssetServiceError("INVALID_ASSET_REFERENCE", "图片资源不存在或已失效");
      }

      assertAssetUsableForTarget(asset, ownerId, target);

      if (asset.status === "UPLOADED") {
        await attachAssetsToEntity(tx, {
          ownerId,
          assetIds: [asset.id],
          target,
        });
      }
      resolved.push(canonicalAssetValue(asset));
      continue;
    }

    resolved.push(token);
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
 *
 * S3 DeleteObject 幂等（对象不存在视为成功）；随后在【同一事务】内完成
 * 条件转移（PENDING_DELETE → DELETED）与配额减额——转移只可能命中一次，
 * 因此两个并发 cleanup worker 也只会有一个完成减额（exactly-once）。
 * 对象删除或事务失败时保留 PENDING_DELETE，由 cleanup 重试。
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

  let completed = false;
  try {
    completed = await prisma.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as Prisma.TransactionClient;
      const claimed = await tx.uploadedAsset.updateMany({
        where: { id: asset.id, status: "PENDING_DELETE" },
        data: { status: "DELETED", expiresAt: null },
      });
      if (batchCount(claimed) !== 1) {
        return false;
      }
      await releaseQuotaBytes(tx, asset.ownerId, asset.sizeBytes);
      return true;
    });
  } catch (error) {
    // 事务失败：转移与减额一并回滚，行保持 PENDING_DELETE 由下次 cleanup 重试
    logger.error("PENDING_DELETE 完成事务失败，保留待重试", "asset-service", {
      operation: "purge",
      assetId: asset.id,
      userId: asset.ownerId,
      error,
    });
    return false;
  }

  if (completed) {
    logger.info("资源已删除", "asset-service", {
      operation: "purge",
      assetId: asset.id,
      userId: asset.ownerId,
      sizeBytes: asset.sizeBytes,
    });
  }
  return completed;
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
    if (trimmed.startsWith("asset:")) {
      const assetId = parseAssetReference(trimmed);
      if (assetId) {
        assetIds.add(assetId);
      }
      // asset: 前缀但非法的值不参与匹配（不应存在）
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
 * - UPLOADING（上传中）/已删除/待删除 → not_found；已过保留期 → expired
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

  if (
    !asset ||
    asset.status === "DELETED" ||
    asset.status === "PENDING_DELETE" ||
    asset.status === "UPLOADING"
  ) {
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

/** 生成私有资源短时签名读 URL（TTL 来自 env，默认 5 分钟）。
 * 响应 Cache-Control 强制 private, no-store：签名过期不等于缓存自动消失。
 * 注意：URL 指向对象存储端点本身，仅供服务端/受信环境使用——
 * 浏览器交付一律走 readPrivateAssetObject 的同源代理（见 /api/assets/[id]/content），
 * 否则 self-hosted 部署下会把不可达的内部 endpoint 泄漏给客户端。 */
export async function createPrivateAssetSignedUrl(asset: {
  bucket: string;
  objectKey: string;
}): Promise<{ url: string; expiresIn: number }> {
  const expiresIn = env.PRIVATE_SIGNED_URL_TTL_SECONDS;
  const url = await getStorage().getSignedReadUrl(
    { bucket: asset.bucket, objectKey: asset.objectKey },
    expiresIn,
    PRIVATE_OBJECT_CACHE_CONTROL,
  );
  return { url, expiresIn };
}

/**
 * 同源代理式私有资产读取：重新执行服务端鉴权（独立于 access API 的任何前置
 * 授权），由 server 使用内部凭据经 S3_ENDPOINT 读取对象内容。
 * self-hosted 生产部署下浏览器无法解析内部 endpoint（如 http://minio:9000），
 * 私有对象必须经由本函数由应用读取后转发。错误路径不泄露 bucket/objectKey/端点。
 */
export async function readPrivateAssetObject(
  assetId: string,
  user: { id: string; role: string },
  now = new Date(),
): Promise<
  | { ok: true; body: Buffer; contentType: string | null; sizeBytes: number }
  | { ok: false; reason: "not_found" | "forbidden" | "expired" }
> {
  const access = await resolvePrivateAssetAccess(assetId, user, now);
  if (!access.ok) {
    // PUBLIC 资产不走私有内容端点（有公开 URL）；统一按不存在处理
    return { ok: false, reason: access.reason === "not_private" ? "not_found" : access.reason };
  }

  const object = await getStorage().getObject({
    bucket: access.asset.bucket,
    objectKey: access.asset.objectKey,
  });
  if (!object) {
    return { ok: false, reason: "not_found" };
  }

  return {
    ok: true,
    body: object.body,
    contentType: object.contentType,
    sizeBytes: object.sizeBytes,
  };
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
