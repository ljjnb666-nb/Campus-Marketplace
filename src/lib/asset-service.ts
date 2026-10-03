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
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { acquireGovernanceSubjectLock } from "@/lib/governance/governance-lock";
import { hasActiveHold } from "@/lib/privacy/data-hold-service";
import { withTransaction } from "@/lib/prisma";
import { hasPermission, loadAuthorizationContext } from "@/lib/rbac/service";

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
 *   [PENDING_DELETE] → [USER governance subject 锁 + fresh hold/行复核]
 *     ↓ S3 DeleteObject（幂等，锁内执行）
 *     ↓ [同一事务: 条件转移 DELETED + 配额减额]（exactly-once）
 *   [DELETED]
 *
 * Phase 9C-01（DataHold-safe destructive boundary）：
 * 物理清除（purgePendingDeleteAsset）与保留期 authoritative 标记
 * （markRetentionExpiredAssetPendingDelete）必须与 createHold / releaseHold /
 * eraseAccount 共享同一把 USER governance subject 锁（governance-lock.ts），
 * 锁内 fresh 复核 ACTIVE DataHold——cleanup 拿到锁并确认无 hold 后才能删除；
 * 并发 createHold 被锁阻塞到 cleanup 提交之后（cleanup wins，合法顺序）；
 * hold 先提交则锁内 fresh check 看到 ACTIVE hold → HOLD_BLOCKED（hold wins），
 * 绝不产生"S3 DeleteObject 已执行而 hold 检查过期"的 TOCTOU。
 *
 * PUT 失败语义（AMBIGUOUS_PUT_OUTCOME，LR-071）：putObject 抛错不代表远端
 * 对象未写入（远端可能已提交而 client 观察到异常）。因此失败路径不删行、
 * 不提前释放配额：UPLOADING → PENDING_DELETE（保留 authoritative recovery
 * row，配额保持占用）→ 尽力一次幂等 DeleteObject；删除被确认后才经 T2
 * 转移 DELETED 并释放配额（exactly-once）。删除未完成则停留 PENDING_DELETE，
 * cleanup 幂等重试。标记失败（DB 故障）则停留 UPLOADING，由 stale 恢复接管。
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
    // LR-071 / AMBIGUOUS_PUT_OUTCOME：putObject 抛错【不证明】远端对象未写入
    // ——远端可能已提交成功而 client 观察到错误（连接在 ACK 前断开等）。
    // 因此禁止"删 UPLOADING 行 + 释放配额"的即时补偿：若对象实际已存在，
    // 会产生无人追踪的 orphan object（DB 无行、配额已释放、存储仍占用）。
    //
    // 安全失败状态（保留 authoritative recovery row）：
    //   UPLOADING → PENDING_DELETE（配额保持占用），随后尽力一次幂等 purge：
    //   - purge 成功 → DeleteObject 确认后 T2 转移 DELETED + 同事务释放配额
    //   - purge 失败 → 行停留 PENDING_DELETE，cleanup 稍后重试（幂等）
    //   - 标记本身失败（DB 故障）→ 行停留 UPLOADING，既有 stale-UPLOADING
    //     恢复路径接管（cleanup 对对象存在/不存在都幂等安全）
    logger.error("对象存储上传失败", "asset-service", {
      operation: "upload",
      event: "storage_upload_unavailable",
      assetId,
      userId,
      category,
      sizeBytes,
      error,
    });

    const marked = await prisma.uploadedAsset
      .updateMany({
        where: { id: assetId, status: "UPLOADING" },
        data: { status: "PENDING_DELETE" },
      })
      .catch((markError) => {
        logger.error("失败上传标记 PENDING_DELETE 失败，行保持 UPLOADING 等待 cleanup", "asset-service", {
          operation: "upload-recover",
          event: "storage_upload_recovery_pending",
          assetId,
          userId,
          sizeBytes,
          error: markError,
        });
        return { count: 0 };
      });

    if (batchCount(marked) === 1) {
      const purge = await purgePendingDeleteAsset(assetId).catch(() => null);
      if (purge?.outcome === "PURGED") {
        logger.info("失败上传恢复完成：对象已删除、配额已释放", "asset-service", {
          operation: "upload-recover",
          event: "storage_upload_recovery_completed",
          assetId,
          userId,
          sizeBytes,
        });
      } else {
        // HOLD_BLOCKED（罕见竞态：上传失败窗口内 owner 被 hold）/
        // NOOP / RETRYABLE_FAILURE —— 行停留 PENDING_DELETE，cleanup 稍后收敛
        logger.warn("远端对象删除未完成，PENDING_DELETE 保留待 cleanup 重试", "asset-service", {
          operation: "upload-recover",
          event: "storage_upload_recovery_pending",
          assetId,
          userId,
          sizeBytes,
        });
      }
    }

    // 对象存储不可用 = external dependency unavailable（非应用 bug）：
    // 503 + Retry-After 合同（route 层附带 header），引导客户端稍后重试。
    // 重试会创建全新 attempt；本 attempt 的恢复由 PENDING_DELETE 生命周期管理。
    throw new AssetServiceError("STORAGE_UPLOAD_FAILED", "图片上传失败，请稍后重试", 503);
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
 * 物理删除结果分类（Phase 9C-01 §7 taxonomy）。
 * hold blocked != failure；lost race != storage failure；存储不可用 != hold blocked。
 * 日志与 cleanup summary 必须能区分这四种结局。
 */
export type AssetPurgeOutcome = "PURGED" | "HOLD_BLOCKED" | "NOOP" | "RETRYABLE_FAILURE";

export interface AssetPurgeResult {
  outcome: AssetPurgeOutcome;
  /** 仅 outcome === "PURGED" 时非 0：本次实际释放的配额字节数（fresh 行 sizeBytes） */
  releasedQuotaBytes: number;
}

/**
 * 物理删除 PENDING_DELETE 资源（canonical destructive authority）。
 *
 * canonical flow（全部在同一个 DB 事务内）：
 *   begin tx
 *   → 取 USER governance subject 锁（与 hold/erasure 同一把锁，TOCTOU 关闭点）
 *   → 锁内 fresh 读取 UploadedAsset（discovery 只是线索，绝不信任 stale 快照：
 *     id / ownerId / status / bucket / objectKey / sizeBytes 全部以 fresh 行为准）
 *   → 锁内 fresh ACTIVE DataHold check（hold lookup subject == lock subject）
 *   → 验证 status == PENDING_DELETE
 *   → S3 DeleteObject（使用 fresh 行定位符；幂等，对象不存在视为成功）
 *   → 条件转移 PENDING_DELETE → DELETED
 *   → 同事务配额减额
 *   → COMMIT
 *
 * 预算算术（不放宽全局事务 timeout）：S3_DELETE_OPERATION_TIMEOUT_MS = 3s
 * 封顶 DeleteObject；同一 subject 上的竞争破坏性操作持锁时长 ≤ 一次
 * delete（3s）+ 点查/点写（毫秒级）；自身 delete ≤ 3s；余量明确
 * （withTransaction 默认 10s，prisma.ts TRANSACTION_TIMEOUT_MS）。
 *
 * 崩溃安全（crash after external success）：S3 删除成功而事务失败/回滚 →
 * 对象可能已不在远端，但行保持 PENDING_DELETE、配额保持占用——下轮 cleanup
 * 对缺失对象再次 DeleteObject（幂等）后完成转移与释放，recovery authority
 * 不丢失。
 *
 * 并发语义：两个 cleanup worker 只有一个能完成转移与减额（条件转移 +
 * subject 锁双重防线），quota decrement exactly once；输家 fresh 读取看到
 * DELETED → NOOP（正常竞争，非失败）。
 */
export async function purgePendingDeleteAsset(assetId: string): Promise<AssetPurgeResult> {
  try {
    const result = await withTransaction(async (tx) => {
      // ownerId 是不可变列（无任何写路径）：仅作 subject 锁键的定位读取。
      // 全部破坏性判定（status / bucket / objectKey / sizeBytes / hold）都在
      // 锁内 fresh 读取上执行；fresh 行 ownerId 与定位读取不一致时 fail closed。
      const located = await tx.uploadedAsset.findUnique({
        where: { id: assetId },
        select: { ownerId: true },
      });
      if (!located) {
        return { outcome: "NOOP" as const, releasedQuotaBytes: 0 };
      }
      await acquireGovernanceSubjectLock(tx, "USER", located.ownerId);

      const fresh = await tx.uploadedAsset.findUnique({ where: { id: assetId } });
      if (!fresh || fresh.ownerId !== located.ownerId) {
        return { outcome: "NOOP" as const, releasedQuotaBytes: 0 };
      }
      if (fresh.status !== "PENDING_DELETE") {
        // 并发 worker 已完成转移（或行被其他路径推进）：正常竞争，非失败
        return { outcome: "NOOP" as const, releasedQuotaBytes: 0 };
      }

      // 锁内 fresh ACTIVE hold check（hold lookup subject == lock subject）。
      // ACTIVE hold 是 business/governance block，不是 storage failure：
      // 对象字节、DB 行、配额全部原样保留，hold 解除后由后续 cleanup 收敛。
      if (await hasActiveHold({ subjectType: "USER", subjectId: fresh.ownerId }, tx)) {
        logger.warn("asset_purge_blocked_by_hold", "asset-service", {
          operation: "purge",
          event: "asset_purge_hold_blocked",
          assetId: fresh.id,
          userId: fresh.ownerId,
        });
        return { outcome: "HOLD_BLOCKED" as const, releasedQuotaBytes: 0 };
      }

      // S3 DeleteObject 在 serialization boundary 内执行（外部副作用被锁覆盖：
      // hold check → delete → DELETED 转移 → 配额释放之间无解锁窗口）
      const storage = getStorage();
      await storage.deleteObject({ bucket: fresh.bucket, objectKey: fresh.objectKey });

      const claimed = await tx.uploadedAsset.updateMany({
        where: { id: fresh.id, status: "PENDING_DELETE" },
        data: { status: "DELETED", expiresAt: null },
      });
      if (batchCount(claimed) !== 1) {
        return { outcome: "NOOP" as const, releasedQuotaBytes: 0 };
      }
      await releaseQuotaBytes(tx, fresh.ownerId, fresh.sizeBytes);
      return { outcome: "PURGED" as const, releasedQuotaBytes: fresh.sizeBytes };
    });

    if (result.outcome === "PURGED") {
      logger.info("资源已删除", "asset-service", {
        operation: "purge",
        assetId,
        sizeBytes: result.releasedQuotaBytes,
      });
    }
    return result;
  } catch (error) {
    // S3 成功后事务失败：转移与减额一并回滚，行保持 PENDING_DELETE、
    // 配额保持占用，由 cleanup 幂等重试（下轮 DeleteObject 对缺失对象安全）
    logger.error("PENDING_DELETE 完成事务失败，保留待重试", "asset-service", {
      operation: "purge",
      assetId,
      error,
    });
    return { outcome: "RETRYABLE_FAILURE", releasedQuotaBytes: 0 };
  }
}

/** 保留期 authoritative 标记结果（Phase 9C-01：candidate discovery != transition） */
export type RetentionMarkOutcome = "MARKED" | "HOLD_BLOCKED" | "NOT_CANDIDATE";

/**
 * 保留期到期的 authoritative PENDING_DELETE 标记（单条、锁内、fresh 复核）。
 *
 * candidate discovery（asset-cleanup 的批量扫描）只是线索；真正的状态推进
 * 必须逐条在 USER governance subject 锁内完成：锁 → fresh 行 → fresh
 * predicate（status ∈ {UPLOADED, ATTACHED} 且 expiresAt < now）→ fresh
 * ACTIVE hold check → 条件 update。hold 已 ACTIVE 时保持原状态
 * （不推进 destructive retention lifecycle），hold 解除后由后续周期收敛。
 */
export async function markRetentionExpiredAssetPendingDelete(
  assetId: string,
  now: Date,
): Promise<RetentionMarkOutcome> {
  return withTransaction(async (tx) => {
    // ownerId 不可变列：仅作锁键定位（同 purgePendingDeleteAsset）
    const located = await tx.uploadedAsset.findUnique({
      where: { id: assetId },
      select: { ownerId: true },
    });
    if (!located) {
      return "NOT_CANDIDATE";
    }
    await acquireGovernanceSubjectLock(tx, "USER", located.ownerId);

    const fresh = await tx.uploadedAsset.findUnique({
      where: { id: assetId },
      select: { id: true, ownerId: true, status: true, expiresAt: true },
    });
    if (
      !fresh ||
      fresh.ownerId !== located.ownerId ||
      !(fresh.status === "UPLOADED" || fresh.status === "ATTACHED") ||
      !fresh.expiresAt ||
      fresh.expiresAt >= now
    ) {
      return "NOT_CANDIDATE";
    }

    if (await hasActiveHold({ subjectType: "USER", subjectId: fresh.ownerId }, tx)) {
      logger.warn("retention_mark_blocked_by_hold", "asset-service", {
        operation: "retention-mark",
        event: "retention_mark_hold_blocked",
        assetId: fresh.id,
        userId: fresh.ownerId,
      });
      return "HOLD_BLOCKED";
    }

    const marked = await tx.uploadedAsset.updateMany({
      where: {
        id: fresh.id,
        status: { in: ["UPLOADED", "ATTACHED"] },
        expiresAt: { lt: now },
      },
      data: { status: "PENDING_DELETE" },
    });
    return batchCount(marked) === 1 ? "MARKED" : "NOT_CANDIDATE";
  });
}

/** 标记 + 物理删除一条资源（业务删除路径的完整入口）。
 * ACTIVE DataHold 时物理清除被 HOLD_BLOCKED（行保持 PENDING_DELETE，
 * hold 解除后由 cleanup 收敛），业务侧表现为本方法返回 false。 */
export async function deleteAssetCompletely(assetId: string): Promise<boolean> {
  const marked = await markAssetPendingDelete(assetId);
  if (!marked) {
    return false;
  }
  const purge = await purgePendingDeleteAsset(assetId);
  return purge.outcome === "PURGED";
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
 *
 * Repair 4 / RB-04：支持传入事务客户端——profile/认证材料替换的旧资源
 * PENDING_DELETE 标记必须与业务 mutation 同一 DB transaction（不再允许
 * "提交后 best-effort + .catch 吞错"：标记失败 = 对象永久泄漏）。
 * 不传 tx 时保持既有全局客户端行为（历史调用方兼容）。
 */
export async function markAssetsForValuesPendingDelete(
  ownerId: string,
  values: string[],
  txClient?: Prisma.TransactionClient,
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

  // 收窄为事务客户端类型：扩展客户端与事务客户端的联合类型会在
  // schema 增大后触发 Prisma 扩展的类型深度超限（excessive stack depth）
  const client = txClient ?? asAssetTx(prisma);
  const result = await client.uploadedAsset.updateMany({
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

export type PrivateAssetGrantedBy = "owner" | "order_participant" | "permission";

export type PrivateAssetAccessResult =
  | {
      ok: true;
      asset: UploadedAsset & {
        rentalOrder: { renterId: string; ownerId: string; rentalListing: { campusId: string } | null } | null;
      };
      grantedBy: PrivateAssetGrantedBy;
      /**
       * Phase 7G：dispute 绑定标记（仅 permission 路径且 category==REPORT 时
       * 解析）。非 null = 该资产被某 dispute 的 evidencePhotos 精确引用（内容
       * 读取路径据此写 DISPUTE_EVIDENCE_ACCESSED 审计）；owner / order
       * participant / 非 REPORT 路径恒 null（常规访问不产生 governance audit）。
       */
      disputeEvidence: { disputeId: string; campusId: string } | null;
    }
  | { ok: false; reason: "not_found" | "not_private" | "expired" | "forbidden" };

/**
 * 私有资源访问授权（Phase 6A 收敛到中央 RBAC）：
 * - owner 本人：账号 active 即可
 * - HANDOVER / RETURN / REPORT：对应租赁订单的租客/出租者
 * - 治理/审核访问：`asset.sensitive.read` permission（取代旧 role 判定），
 *   campus-scoped 授权必须与资产所属校区精确匹配（默认拒绝；
 *   资产校区不可解析时仅 GLOBAL 授权放行）；
 *   Phase 7F：VERIFICATION 绑定资产额外接受 `verification.evidence.read`
 *   （同样 campus 精确匹配）——该窄权限对其它 category 恒 NO ACCESS。
 *   RB-01 review fix：非 owner 的 VERIFICATION operator 访问还必须满足
 *   ATTACHED + verification 绑定 + membership ACTIVE（scope truth 唯一取
 *   verification.membership.campusId，无 owner-campus 回退）——"已上传未
 *   提交"的孤儿认证资产对任何 operator 都不可读（owner 本人除外）
 * - UPLOADING（上传中）/已删除/待删除 → not_found；已过保留期 → expired
 *
 * 资产校区解析（按绑定关系）：认证材料 → membership.campusId；
 * 租赁单/租赁列表 → rentalListing.campusId；商品/服务 → 各自 listing；
 * 其余（头像/举报附件）→ owner 的 ACTIVE membership 校区。
 */
export async function resolvePrivateAssetAccess(
  assetId: string,
  user: { id: string },
  now = new Date(),
): Promise<PrivateAssetAccessResult> {
  const asset = await prisma.uploadedAsset.findFirst({
    where: { id: assetId },
    include: {
      rentalOrder: {
        select: {
          renterId: true,
          ownerId: true,
          rentalListing: { select: { campusId: true } },
        },
      },
      verification: { select: { membership: { select: { campusId: true, status: true } } } },
      rentalListing: { select: { campusId: true } },
      product: { select: { campusId: true } },
      serviceListing: { select: { campusId: true } },
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

  // 访问者账号状态复核（active-account enforcement，与 Phase 5 一致）：
  // 停用/已删除/已注销账号的一切私有资源访问 fail closed
  const context = await loadAuthorizationContext(user.id);
  if (!context || !context.accountActive) {
    return { ok: false, reason: "forbidden" };
  }

  if (asset.ownerId === user.id) {
    return { ok: true, asset, grantedBy: "owner", disputeEvidence: null };
  }

  const order = asset.rentalOrder;
  const orderParticipant =
    order !== null && (order.renterId === user.id || order.ownerId === user.id);

  const categoryAllowsOrderParticipants: AssetCategory[] = ["HANDOVER", "RETURN", "REPORT"];
  if (orderParticipant && categoryAllowsOrderParticipants.includes(asset.category)) {
    return { ok: true, asset, grantedBy: "order_participant", disputeEvidence: null };
  }

  if (asset.category === "VERIFICATION") {
    // RB-01 Repair 2 review fix（VERIFICATION_ASSET_OPERATOR_ACCESS_INVARIANT）：
    // 非 owner 的认证材料 operator 授权必须全部满足——
    //   access = PRIVATE（非 PRIVATE 已在上方 not_private 分支统一处理）
    //   + status = ATTACHED（UPLOADED = 尚未提交认证的孤儿上传，禁止任何
    //     operator 读取）
    //   + 存在 verification 绑定（asset.verification !== null）
    //   + membership.status = ACTIVE（与 Phase 7F 审核读模型同一 scope
    //     truth：审核详情对非 ACTIVE membership fail closed，直连内容
    //     不得更宽，防止 "review page = deny / direct content = allow"）
    //   + 授权 campus 唯一取 asset.verification.membership.campusId。
    // 禁止 owner-campus 回退推导（GLOBAL grant 因此不再能读取未绑定上传）。
    // owner 本人路径不受影响（上传后、提交前的预览能力为既有合同）。
    const verificationBinding = asset.verification;
    if (
      asset.status !== "ATTACHED" ||
      !verificationBinding ||
      verificationBinding.membership.status !== "ACTIVE"
    ) {
      return { ok: false, reason: "forbidden" };
    }

    const evidenceCampusId = verificationBinding.membership.campusId;
    if (
      hasPermission(context, "asset.sensitive.read", evidenceCampusId) ||
      hasPermission(context, "verification.evidence.read", evidenceCampusId)
    ) {
      return { ok: true, asset, grantedBy: "permission", disputeEvidence: null };
    }
    return { ok: false, reason: "forbidden" };
  }

  const targetCampusId =
    asset.rentalOrder?.rentalListing.campusId ??
    asset.rentalListing?.campusId ??
    asset.product?.campusId ??
    asset.serviceListing?.campusId ??
    null;

  const permissionTargetCampusId =
    targetCampusId ??
    (
      await prisma.campusMembership.findFirst({
        where: { userId: asset.ownerId, status: "ACTIVE" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { campusId: true },
      })
    )?.campusId ??
    null;

  if (asset.category === "REPORT") {
    // Phase 7G：dispute.evidence.read 窄授权——放行条件必须全部成立：
    // (1) asset.category == REPORT；(2) asset token 精确出现在某 dispute 的
    // evidencePhotos 内（绝不能因 asset.rentalOrderId == orderId 就放行同订单
    // 全部 REPORT assets——否则会顺便暴露 damage-claim 等非 dispute 证据）；
    // (3) dispute scope campus 精确匹配（GLOBAL grant 覆盖全部校区）。
    // 与既有 asset.sensitive.read 并列（OR）——其原语义不变（DE06）。
    const disputeBinding = await prisma.rentalDispute.findFirst({
      where: {
        evidencePhotos: { has: buildAssetReference(asset.id) },
      },
      select: { id: true, campusId: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const disputeEvidence =
      disputeBinding && disputeBinding.campusId !== null
        ? { disputeId: disputeBinding.id, campusId: disputeBinding.campusId }
        : null;

    if (
      (disputeEvidence !== null &&
        hasPermission(context, "dispute.evidence.read", disputeEvidence.campusId)) ||
      hasPermission(context, "asset.sensitive.read", permissionTargetCampusId)
    ) {
      return { ok: true, asset, grantedBy: "permission", disputeEvidence };
    }
    return { ok: false, reason: "forbidden" };
  }

  if (hasPermission(context, "asset.sensitive.read", permissionTargetCampusId)) {
    return { ok: true, asset, grantedBy: "permission", disputeEvidence: null };
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
 * 返回 grantedBy/category 供调用方记录敏感访问审计（VERIFICATION 材料的
 * permission 路径访问本身即审计事件）。
 */
export async function readPrivateAssetObject(
  assetId: string,
  user: { id: string },
  now = new Date(),
): Promise<
  | {
      ok: true;
      body: Buffer;
      contentType: string | null;
      sizeBytes: number;
      grantedBy: PrivateAssetGrantedBy;
      category: AssetCategory;
      /** Phase 7G：dispute 绑定标记（非 null = dispute evidence，内容路径须审计） */
      disputeEvidence: { disputeId: string; campusId: string } | null;
    }
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
    grantedBy: access.grantedBy,
    category: access.asset.category,
    disputeEvidence: access.disputeEvidence,
  };
}

/**
 * Phase 7G：dispute evidence 的治理读取审计（DE07 合同，content 路由消费）。
 * 仅当读取结果是"REPORT 且被某 dispute 的 evidencePhotos 精确绑定"时写
 * DISPUTE_EVIDENCE_ACCESSED；owner / order participant 常规访问
 * （disputeEvidence=null）不产生 governance audit。metadata 仅机器可读
 * 白名单键（不含 dispute reason / evidence URL）。
 */
export async function recordDisputeEvidenceAuditIfNeeded(
  actorId: string,
  read: {
    category: AssetCategory;
    grantedBy: PrivateAssetGrantedBy;
    disputeEvidence: { disputeId: string; campusId: string } | null;
  },
  assetId: string,
): Promise<void> {
  if (read.category === "REPORT" && read.disputeEvidence !== null) {
    await recordAdminAudit({
      actorId,
      action: "DISPUTE_EVIDENCE_ACCESSED",
      targetType: "UPLOADED_ASSET",
      targetId: assetId,
      campusId: read.disputeEvidence.campusId,
      metadata: {
        assetCategory: read.category,
        grantedBy: read.grantedBy,
        disputeId: read.disputeEvidence.disputeId,
      },
    });
  }
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
