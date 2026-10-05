import { createHash } from "node:crypto";

import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { DATA_EXPORT_ARTIFACT_MIME_TYPE } from "@/lib/privacy/data-export-contract";

/**
 * Phase 9C-03：authorized same-origin export download 解析与读取。
 *
 * 安全契约（§29-§34）：
 * - authenticated + same-user only；request.type 必须 = DATA_EXPORT
 * - anti-oracle（§32）：request 不存在 / 他人 request / 类型漂移 → 404
 *   同形（绝不 403 "这是其他用户的数据"，不泄漏 request existence）
 * - 下载条件（INV-9C03-08）：本人 + request COMPLETED + artifact READY
 *   + 未过期 + 未删除
 * - bucket/objectKey/内部端点绝不进入响应体或浏览器可见面（§30）：
 *   application server 以服务端凭据 getObject 同源代理
 * - 完整性（§34）：object 必须存在、sizeBytes 与 READY 登记一致；
 *   sha256 复核不一致时绝不向用户返回 corrupted JSON，记录安全
 *   machine event
 * - 过期 / 已删除 → 410（own request 可理解语义；跨用户仍 404 同形）
 */

export type ExportDownloadFailure = {
  ok: false;
  status: number;
  code:
    | "EXPORT_DOWNLOAD_NOT_FOUND"
    | "EXPORT_NOT_READY"
    | "EXPORT_GENERATION_FAILED"
    | "EXPORT_EXPIRED"
    | "EXPORT_ARTIFACT_UNAVAILABLE"
    | "EXPORT_ARTIFACT_CORRUPTED";
  message: string;
};

export type ExportDownloadSuccess = {
  ok: true;
  body: Buffer;
  contentType: string;
  filename: string;
  sizeBytes: number;
};

export type ExportDownloadResult = ExportDownloadSuccess | ExportDownloadFailure;

const DOWNLOAD_FILENAME_PREFIX = "campus-data-export";

export async function readExportArtifactForDownload(
  requestId: string,
  sessionUserId: string,
): Promise<ExportDownloadResult> {
  const request = await prisma.privacyRequest.findUnique({
    where: { id: requestId },
    include: { artifact: true },
  });

  // §32 anti-oracle：不存在 / 他人 request / 类型漂移全部 404 同形
  if (!request || request.type !== "DATA_EXPORT" || request.userId !== sessionUserId) {
    return {
      ok: false,
      status: 404,
      code: "EXPORT_DOWNLOAD_NOT_FOUND",
      message: "导出文件不存在",
    };
  }

  // 本人 request 非终态：可理解的稳定语义（409）
  if (request.status === "REJECTED") {
    return {
      ok: false,
      status: 409,
      code: "EXPORT_GENERATION_FAILED",
      message: "导出文件生成失败，请重新申请",
    };
  }

  if (request.status !== "COMPLETED" || !request.artifact) {
    return {
      ok: false,
      status: 409,
      code: "EXPORT_NOT_READY",
      message: "导出文件尚未生成完成",
    };
  }

  const artifact = request.artifact;

  // INV-9C03-08：只有 READY + 未过期 + 未删除可下载
  if (
    artifact.status !== "READY" ||
    artifact.deletedAt ||
    !artifact.expiresAt ||
    artifact.expiresAt.getTime() <= Date.now()
  ) {
    return {
      ok: false,
      status: 410,
      code: "EXPORT_EXPIRED",
      message: "文件已过期，请重新申请",
    };
  }

  const storage = getStorage();
  const metadata = await storage.headObject({
    bucket: artifact.bucket,
    objectKey: artifact.objectKey,
  });

  if (!metadata) {
    // READY 行但对象缺失（存储侧异常/提前被删）：绝不静默 500/404，
    // 记录安全 machine event，明确不可用
    logger.error("data_export_artifact_object_missing", "privacy", {
      event: "data_export_artifact_object_missing",
      requestId,
      artifactId: artifact.id,
    });
    return {
      ok: false,
      status: 409,
      code: "EXPORT_ARTIFACT_UNAVAILABLE",
      message: "导出文件暂时不可用，请稍后重试或重新申请",
    };
  }

  if (artifact.sizeBytes > 0 && metadata.sizeBytes !== artifact.sizeBytes) {
    // §34：size 不 sane —— 绝不向用户返回可疑内容
    logger.error("data_export_artifact_size_mismatch", "privacy", {
      event: "data_export_artifact_size_mismatch",
      requestId,
      artifactId: artifact.id,
    });
    return {
      ok: false,
      status: 409,
      code: "EXPORT_ARTIFACT_CORRUPTED",
      message: "导出文件校验失败，请重新申请",
    };
  }

  const object = await storage.getObject({
    bucket: artifact.bucket,
    objectKey: artifact.objectKey,
  });

  if (!object) {
    logger.error("data_export_artifact_object_read_failed", "privacy", {
      event: "data_export_artifact_object_read_failed",
      requestId,
      artifactId: artifact.id,
    });
    return {
      ok: false,
      status: 409,
      code: "EXPORT_ARTIFACT_UNAVAILABLE",
      message: "导出文件暂时不可用，请稍后重试或重新申请",
    };
  }

  // §34：sha256 复核（实现成本低——内容已在内存；不一致绝不返回）
  if (artifact.sha256) {
    const digest = createHash("sha256").update(object.body).digest("hex");

    if (digest !== artifact.sha256) {
      logger.error("data_export_artifact_sha256_mismatch", "privacy", {
        event: "data_export_artifact_sha256_mismatch",
        requestId,
        artifactId: artifact.id,
      });
      return {
        ok: false,
        status: 409,
        code: "EXPORT_ARTIFACT_CORRUPTED",
        message: "导出文件校验失败，请重新申请",
      };
    }
  }

  // §31：filename 只含 requestId（cuid 机器字符），绝不包含
  // email / name / studentId
  return {
    ok: true,
    body: object.body,
    contentType: DATA_EXPORT_ARTIFACT_MIME_TYPE,
    filename: `${DOWNLOAD_FILENAME_PREFIX}-${requestId}.json`,
    sizeBytes: object.body.byteLength,
  };
}
