/**
 * S3 写入错误分类器（LR-R3 可观测性）。
 *
 * 职责边界（PRIMARY INVARIANT）：分类结果【只】用于结构化日志/指标，
 * 供故障诊断区分"可证明未送达"与"结果未知"。asset 状态机的恢复行为对
 * 两类错误完全一致（LR-071 统一安全路径）——不存在"definite 就地释放配额"
 * 的分支，因此分类错误也不可能引发配额泄漏。
 *
 * 分类规则（保守优先：宁可将不确定错误归 AMBIGUOUS）：
 *
 * AMBIGUOUS_WRITE_FAILURE（默认）：
 * - 客户端 abort（AbortError）：abort ≠ 证明远端未提交——请求可能在 abort
 *   前已完整到达服务器并提交成功。
 * - 一切 TimeoutError（connect / socket inactivity / request 超限，@smithy
 *   将这三者统一命名为 TimeoutError）：无法证明请求字节未到达对端。
 * - ECONNRESET / EPIPE / ETIMEDOUT：连接曾建立，请求可能已发送。
 * - HTTP 状态错误（4xx/5xx）、未知结构错误。
 * - 多次 attempt 后的任何错误：即使最终错误是 ECONNREFUSED，之前的 attempt
 *   可能已连接成功并提交（之后服务才下线）——SDK 只暴露最后一个错误。
 *
 * DEFINITE_CONNECT_FAILURE（可证明远端零副作用，唯一例外）：
 * - 仅一次 attempt（error.$metadata.attempts === 1，由 SDK retry middleware
 *   在抛出前写入），且错误码属于连接建立/DNS 阶段（ECONNREFUSED /
 *   ENOTFOUND / EAI_AGAIN）——TCP 连接从未建立，请求字节不可能到达服务器。
 */

export type S3StorageWriteErrorClass =
  | "DEFINITE_CONNECT_FAILURE"
  | "AMBIGUOUS_WRITE_FAILURE";

export interface S3StorageWriteErrorClassification {
  errorClass: S3StorageWriteErrorClass;
  /** true = 可证明该请求从未送达远端（唯一可信的"零副作用"证据） */
  definitePreCommitFailure: boolean;
  /** SDK retry middleware 记录的 attempt 数；非 SDK 错误为 null */
  attempts: number | null;
  errorName: string | null;
  errorCode: string | null;
}

/** 连接建立/DNS 阶段失败：TCP 从未连上，请求字节不可能已送达 */
const CONNECT_PHASE_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

export function classifyStorageWriteError(
  error: unknown,
): S3StorageWriteErrorClassification {
  const source = error as {
    name?: unknown;
    code?: unknown;
    $metadata?: { attempts?: unknown };
  } | null;

  const attemptsRaw = source?.$metadata?.attempts;
  const attempts =
    typeof attemptsRaw === "number" && Number.isFinite(attemptsRaw) && attemptsRaw >= 1
      ? attemptsRaw
      : null;

  const errorName = typeof source?.name === "string" ? source.name : null;
  const errorCode = typeof source?.code === "string" ? source.code : null;

  const definitePreCommitFailure =
    attempts === 1 && errorCode !== null && CONNECT_PHASE_ERROR_CODES.has(errorCode);

  return {
    errorClass: definitePreCommitFailure
      ? "DEFINITE_CONNECT_FAILURE"
      : "AMBIGUOUS_WRITE_FAILURE",
    definitePreCommitFailure,
    attempts,
    errorName,
    errorCode,
  };
}
