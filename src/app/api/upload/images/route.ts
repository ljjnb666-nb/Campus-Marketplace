import { NextRequest, NextResponse } from "next/server";
import { withHttpMetrics } from "@/lib/http-metrics";
import {
  VERIFIED_SESSION_HTTP_STATUS,
  getVerifiedSession,
} from "@/lib/server-auth";
import {
  AssetServiceError,
  isImageValidationError,
  uploadImageAsset,
} from "@/lib/asset-service";
import { actionErrorMessage } from "@/lib/error-handler";
import { logger } from "@/lib/logger";
import { isRateLimited } from "@/lib/rate-limit";
import { isUploadCategory, UPLOAD_LIMITS } from "@/lib/upload";

const MAX_REQUESTS_PER_MINUTE = 20;
const RATE_LIMIT_WINDOW_MS = 60000;

/**
 * OUTER REQUEST ENVELOPE LIMIT（请求体总上限，含 multipart overhead）。
 *
 * 与 FILE 类目上限（5MiB / 10MiB，见 upload-limits.ts）是两个独立 contract：
 * - 外层信封上限负责资源保护（防止无限 multipart body），值与生产 Caddy
 *   的 request_body max_size 12MB 对齐——10MiB 文件 + multipart 开销
 *   （实测 ~10.51MB）留有余量；
 * - 类目上限负责业务语义（超限 → 413 FILE_TOO_LARGE），保持不变。
 *
 * 生产边界（A7）：公网流量经 Caddy（字节级 authoritative outer cap，
 * 覆盖 chunked / 缺失 Content-Length），app 端口不对公网暴露。本常量
 * 仅为【直连内部流量】提供同语义的快速拒绝（fast rejection）——请求可以
 * 没有或伪造 Content-Length，因此它不是唯一保护，也不能替代 Caddy。
 * 同时 next.config.ts 的 experimental.proxyClientMaxBodySize(13MB) 必须
 * 大于本信封 + Caddy 余量，否则框架会在解析前截断 body 导致 parser 报错。
 */
const UPLOAD_REQUEST_ENVELOPE_MAX_BYTES = 12 * 1000 * 1000;

/** STORAGE_UPLOAD_FAILED(503) 的固定有界重试提示（秒）：小型、不放大风暴 */
const STORAGE_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

async function postHandler(request: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  let category = "unknown";

  try {
    // 上传属于业务 mutation：需要账户状态复核 + consent gate（不可绕过）
    const verified = await getVerifiedSession({ requireConsent: true });

    if (!verified.ok) {
      return NextResponse.json(
        {
          error:
            verified.reason === "LEGAL_ACCEPTANCE_REQUIRED"
              ? "请先阅读并同意最新的平台协议"
              : "未登录，请先登录",
          code: verified.reason,
        },
        { status: VERIFIED_SESSION_HTTP_STATUS[verified.reason] }
      );
    }
    userId = verified.user.id;

    const { limited } = await isRateLimited({
      key: userId,
      limit: MAX_REQUESTS_PER_MINUTE,
      windowMs: RATE_LIMIT_WINDOW_MS,
    });

    if (limited) {
      return NextResponse.json(
        { error: "上传过于频繁，请稍后再试" },
        { status: 429 }
      );
    }

    // 外层信封快速拒绝（A7）：只信任为数值的 Content-Length；缺失/伪造时
    // 仍会进入真实解析，生产公网流量由 Caddy 做字节级保护。
    const contentLength = Number(request.headers.get("content-length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > UPLOAD_REQUEST_ENVELOPE_MAX_BYTES
    ) {
      logger.warn("上传请求体超过外层信封上限", "POST /api/upload/images", {
        operation: "upload",
        event: "upload_rejected_too_large",
        reason: "REQUEST_ENVELOPE",
        userId,
        category,
        contentLength,
        envelopeMaxBytes: UPLOAD_REQUEST_ENVELOPE_MAX_BYTES,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: "上传请求过大", code: "REQUEST_TOO_LARGE" },
        { status: 413 }
      );
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch (error) {
      // LR-001：multipart 解析失败 = 客户端输入问题（格式非法 / Content-Type
      // 错误 / body 被截断），必须归类 400，绝不落入 generic 500；
      // 此时尚未触达任何 DB / S3 副作用（零副作用不变量）。
      logger.warn("multipart 解析失败", "POST /api/upload/images", {
        operation: "upload",
        event: "upload_rejected_invalid_multipart",
        userId,
        category,
        errorName: error instanceof Error ? error.name : "unknown",
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: "上传数据格式不正确，请重新选择文件", code: "INVALID_MULTIPART" },
        { status: 400 }
      );
    }

    const file = formData.get("file") as File | null;
    const rawCategory = String(formData.get("category") ?? "product");
    category = rawCategory;

    if (!file) {
      return NextResponse.json(
        { error: "未选择文件" },
        { status: 400 }
      );
    }

    // 白名单校验，避免原型链属性（如 "constructor"）绕过下标检查
    if (!isUploadCategory(rawCategory)) {
      return NextResponse.json(
        { error: "无效的上传分类" },
        { status: 400 }
      );
    }

    const limits = UPLOAD_LIMITS[rawCategory];

    if (!(limits.allowedTypes as readonly string[]).includes(file.type)) {
      return NextResponse.json(
        { error: "不支持的图片格式，仅支持JPG、PNG和WebP" },
        { status: 400 }
      );
    }

    if (file.size > limits.maxSize) {
      const maxSizeMB = Math.floor(limits.maxSize / (1024 * 1024));
      logger.warn("上传文件超过类目大小上限", "POST /api/upload/images", {
        operation: "upload",
        event: "upload_rejected_too_large",
        reason: "FILE_LIMIT",
        userId,
        category,
        sizeBytes: file.size,
        limitBytes: limits.maxSize,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: `图片大小不能超过${maxSizeMB}MB`, code: "FILE_TOO_LARGE" },
        { status: 413 }
      );
    }

    const result = await uploadImageAsset({
      userId,
      category: rawCategory,
      file,
    });

    logger.info("图片上传接口完成", "POST /api/upload/images", {
      operation: "upload",
      assetId: result.assetId,
      userId,
      category,
      sizeBytes: result.sizeBytes,
      durationMs: Date.now() - startedAt,
    });

    // 私有资源不返回 URL：业务侧保存 assetId，访问时经签名接口换取短时 URL
    return NextResponse.json({
      success: true,
      assetId: result.assetId,
      access: result.access,
      url: result.url,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
    });
  } catch (error) {
    if (error instanceof AssetServiceError) {
      // LR-071：稳定 machine code 随 body 返回（additive，不删除 error）；
      // 503（外部依赖不可用）附带固定有界的 Retry-After 合同。
      const headers: Record<string, string> =
        error.status === 503
          ? {
              "Retry-After": String(STORAGE_UNAVAILABLE_RETRY_AFTER_SECONDS),
            }
          : {};
      logger.warn("图片上传被拒绝", "POST /api/upload/images", {
        operation: "upload",
        userId,
        category,
        errorCode: error.code,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status, headers }
      );
    }
    if (isImageValidationError(error)) {
      logger.warn("图片内容校验未通过", "POST /api/upload/images", {
        operation: "upload",
        userId,
        category,
        errorCode: error.code,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 }
      );
    }
    logger.error("图片上传失败", "POST /api/upload/images", {
      operation: "upload",
      userId,
      category,
      durationMs: Date.now() - startedAt,
      error,
    });
    return NextResponse.json(
      { error: actionErrorMessage(error, "POST /api/upload/images") },
      { status: 500 }
    );
  }
}

export const POST = withHttpMetrics("upload/images", postHandler);
