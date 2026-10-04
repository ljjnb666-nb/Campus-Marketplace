import { env } from "@/lib/env";
import { assertSafeObjectKey } from "@/lib/storage/object-key";

/**
 * Phase 9C-03：async durable data export 纯契约层。
 *
 * 职责（§14/§15/§26/§47/§48）：
 * - deterministic object key：requestId → exactly one object key（重试 /
 *   ambiguous PUT 重放安全——绝不允许每次 retry 生成 random key 产生
 *   orphan object 副本）；
 * - async 资源上界（DATA_EXPORT_ARTIFACT_MAX_BYTES，env 可配置）：这是
 *   async worker 的 operational resource safety limit，不是旧同步 HTTP
 *   响应保护（EXPORT_MAX_BYTES=8MiB 已随 executeSynchronousDataExport
 *   退出产品契约）。超限明确 REJECTED（不静默截断），记录为未来
 *   streaming export 的扩展点——本阶段不声称"无限支持"；
 * - artifact TTL：从 artifact READY / request COMPLETED 起算（绝不从
 *   REQUESTED 起算，排队时间不得吞掉下载窗口）；
 * - execution policy 预算算术（§47/§48，与 EMAIL RB06 同一冻结方式，
 *   静态不变量测试锁定）。
 *
 * snapshot 语义（§44 准确表述）：export 是生成期间的 best-effort
 * point-in-time logical snapshot；PrivacyRequest lifecycle 与 artifact
 * finalization 有明确事务边界，业务表不承诺单一数据库 snapshot。
 */

/** artifact 内容类型（v3 format 不变，compact JSON 不 pretty print） */
export const DATA_EXPORT_ARTIFACT_MIME_TYPE = "application/json; charset=utf-8";

/** 私有对象 Cache-Control（与 asset-service.PRIVATE_OBJECT_CACHE_CONTROL 同惯例） */
export const DATA_EXPORT_ARTIFACT_CACHE_CONTROL = "private, no-store";

/** artifact 所在 bucket（私有 bucket；bucket 名绝不进入 browser-visible surface） */
export function dataExportArtifactBucket(): string {
  return env.S3_BUCKET_PRIVATE;
}

const REQUEST_ID_PATTERN = /^[a-z0-9]{20,40}$/;

/**
 * deterministic object key（§11）：
 *
 *   private/data-exports/<userId>/<requestId>.json
 *
 * 不变量：requestId → exactly one object key。Step A（prepare）在【任何
 * S3 PUT 之前】把 WRITING artifact 连同该 key durable 落库——因此
 * ambiguous PUT（远端可能已提交）后无论 retry 还是 REJECT，对象 key
 * 始终被 DB 行追踪，cleanup 必然收敛，绝不产生 orphan 副本。
 */
export function buildDataExportObjectKey(userId: string, requestId: string): string {
  // cuid 形态校验（小写字母数字）：userId / requestId 均为服务端生成的
  // cuid，绝不接受用户可 Influenced 文本进入 key（assertSafeObjectKey
  // 再做穿越兜底）。
  if (!REQUEST_ID_PATTERN.test(userId) || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("非法的导出 object key：ID 形态不合法");
  }

  const objectKey = `private/data-exports/${userId}/${requestId}.json`;
  assertSafeObjectKey(objectKey);
  return objectKey;
}

/** artifact 下载窗口截止（readyAt + TTL；TTL 集中 config，默认 24h） */
export function dataExportArtifactExpiresAt(readyAt: Date): Date {
  return new Date(readyAt.getTime() + env.DATA_EXPORT_ARTIFACT_TTL_HOURS * 60 * 60 * 1000);
}

/** async 资源上界（worker 读取 env，集中校验下限 > 8MiB 由 env schema 强制） */
export function dataExportArtifactMaxBytes(): number {
  return env.DATA_EXPORT_ARTIFACT_MAX_BYTES;
}

// ============================================================
// RB06（Phase 9C-03）：DATA_EXPORT_GENERATE execution budget。
//
// execution transaction 在 serialization boundary（USER governance lock
// + AsyncJob 行锁）内完成 export build（多查询 DB 读）+ 序列化 + S3 PUT
// + finalization 提交，因此事务预算必须覆盖最坏合法路径：
//
//   build+serialize：DTO 读 + ≤ DATA_EXPORT_ARTIFACT_MAX_BYTES（默认
//     32 MiB）JSON.stringify 预算 20s；
//   S3 PUT：专用 export 操作预算 30s（有界，见
//     DATA_EXPORT_S3_PUT_OPERATION_TIMEOUT_MS——默认 5s 的图像 PUT
//     预算按小对象调定，不适用 MiB 级对象）；
//   DB finalization + commit safety：10s。
//
//   DATA_EXPORT_GENERATE_EXECUTION_TX_TIMEOUT_MS (60s) ≥ 20 + 30 + 10
//   DATA_EXPORT_GENERATE_EXECUTION_LEASE_SECONDS (90s)
//     > 60s tx max + 10s completion margin（EMAIL-LEASE 同一算术：
//     否则 COMMIT 后 completion marker 落库前进入 expired-lease
//     reclaim 窗口，与 9A crash-recovery 合同冲突）。
//
// 两常量为静态不变量测试（EXPORT-TX-BUDGET-01 / EXPORT-LEASE-BUDGET-01）
// 的冻结基线；调整任一侧必须同步复核本注释的算术。
// 有界性（§48）：预算按 artifact max bytes + PUT budget + benchmark 确定，
// 绝不用"30min timeout / 1h lease"掩盖架构问题。
// ============================================================

export const DATA_EXPORT_S3_PUT_OPERATION_TIMEOUT_MS = 30_000;
export const DATA_EXPORT_GENERATE_EXECUTION_TX_TIMEOUT_MS = 60_000;
export const DATA_EXPORT_GENERATE_EXECUTION_LEASE_SECONDS = 90;

/**
 * §20/§21：PrivacyRequest REJECTED 稳定 reasonCode（异步导出失败收敛）。
 * machine code，全链统一；用户面文案由 UI 状态标签呈现，不透传细节。
 */
export const DATA_EXPORT_REJECT_REASON = {
  /** 超过 async 资源上界（DATA_EXPORT_ARTIFACT_MAX_BYTES） */
  TOO_LARGE: "DATA_EXPORT_ARTIFACT_TOO_LARGE",
  /** 生成执行失败（retry 预算耗尽 / 结构性损坏收敛） */
  GENERATION_FAILED: "DATA_EXPORT_GENERATION_FAILED",
  /** erasure wins：账号已注销，绝不允许 artifact 复活 */
  OWNER_ERASED: "ACCOUNT_ALREADY_DELETED",
  /** erasure wins 变体：账号 inactive（suspended / deleted） */
  OWNER_INACTIVE: "EXPORT_OWNER_ACCOUNT_INACTIVE",
} as const;
