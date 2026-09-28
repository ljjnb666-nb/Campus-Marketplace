import { S3Client } from "@aws-sdk/client-s3";

/**
 * S3 传输契约（LR-R3 / STORAGE_OUTAGE_UPLOAD_LONG_TAIL）：
 *
 * 修复前 S3Client 未配置任何超时/重试预算——@smithy/node-http-handler 的
 * connectionTimeout / socketTimeout / requestTimeout 默认全为 0（禁用），
 * SDK 默认 maxAttempts=3 + standard 重试把 ECONNREFUSED / TimeoutError 等
 * 一律按 TRANSIENT 重试，故障长尾完全由 OS TCP 行为 + SDK 重试链决定
 * （rehearsal 实测存储硬不可用 → 上传 ~36s 才返回 503）。
 *
 * 本模块是传输层预算的唯一权威：所有 S3Client 都必须经 createBoundedS3Client
 * 构造（含测试），业务层（route/asset-service）不得自行包装 timeout race。
 *
 * 预算取值依据（部署拓扑：app 与 MinIO 同 compose 内网，RTT < 50ms，
 * 单对象 ≤ 10MiB）：
 * - CONNECT_TIMEOUT 2s：健康 MinIO 建连 < 100ms，20× 余量；封顶"SYN 被丢弃"
 *   的 connect-hang（OS 默认可挂 20s+）。
 * - SOCKET_TIMEOUT 3s：socket 空闲（inactivity）上限。慢但活跃的传输会持续
 *   复位计时器不受影响；对端 accept 后静默（blackhole）在 3s 内退出。
 * - REQUEST_TIMEOUT 4s（每次 attempt）：单次 attempt 的请求+响应总时长，
 *   LAN 上传 10MiB 典型 < 0.5s，4× 余量；须 throwOnRequestTimeout 才抛错。
 * - MAX_ATTEMPTS 2：PUT 非幂等语义下仅保留一次瞬时抖动重试（SDK 对
 *   ECONNRESET/TimeoutError 会重试——重试可能重复提交同一对象，但同 key
 *   同 body 重复 PUT 最终状态一致，且歧义结果由 asset 状态机的
 *   PENDING_DELETE 恢复路径兜底）。
 *
 * 失败语义（PRIMARY INVARIANT）：任何 send 错误——包括客户端 abort /
 * 超时——都不证明远端 PUT 未提交。分类只用于可观测性（见
 * s3-write-error-classifier），恢复行为保持 LR-071 统一安全路径
 * （PENDING_DELETE → 幂等 purge → cleanup），绝无"超时即释放配额"分支。
 */

export const S3_MAX_ATTEMPTS = 2;
export const S3_CONNECT_TIMEOUT_MS = 2000;
export const S3_SOCKET_TIMEOUT_MS = 3000;
/** 单次 attempt 的请求+响应预算（非整个操作预算） */
export const S3_REQUEST_TIMEOUT_MS = 4000;
/**
 * putObject 整个操作（含 SDK 重试 + 退避）的 abort 上限。位于上传 HTTP 请求
 * 关键路径上；超限产生 AbortError → 不可重试 → 按歧义结果安全恢复。
 */
export const S3_PUT_OPERATION_TIMEOUT_MS = 5000;
/**
 * deleteObject 整个操作 abort 上限。上传失败恢复路径会在请求内联执行一次
 * 幂等 purge DELETE（PUT 5s 预算之后），两段合计封顶 ~8s；cleanup worker
 * 调用同一方法，超限失败由下个周期幂等重试。
 */
export const S3_DELETE_OPERATION_TIMEOUT_MS = 3000;

export interface S3ClientBaseConfig {
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

/**
 * 构造带应用级传输契约的 S3Client。唯一构造入口（生产 getStorage 与
 * 测试共用），保证测试测到的就是生产行为。
 */
export function createBoundedS3Client(config: S3ClientBaseConfig): S3Client {
  return new S3Client({
    ...config,
    maxAttempts: S3_MAX_ATTEMPTS,
    retryMode: "standard",
    requestHandler: {
      connectionTimeout: S3_CONNECT_TIMEOUT_MS,
      socketTimeout: S3_SOCKET_TIMEOUT_MS,
      requestTimeout: S3_REQUEST_TIMEOUT_MS,
      // 无此开关时 requestTimeout 超限仅记 warning 不抛错（@smithy v4 行为）
      throwOnRequestTimeout: true,
    },
  });
}
