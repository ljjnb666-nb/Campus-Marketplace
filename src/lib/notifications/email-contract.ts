import { z } from "zod";

/**
 * Phase 9B：transactional email 纯契约常量（alias-free leaf）。
 *
 * 本文件不得 import 任何 "@/..." 路径——scripts/production-env-check.ts
 * 由 tsx CLI 直接执行（CJS 模式，不解析 tsconfig paths），经相对路径
 * 引用本模块（metrics-token 同一惯例）。依赖 PermanentJobFailure 的
 * 受控错误类型在 email-config.ts（CLI 链路绝不 import 该文件）。
 */

export const OFFICIAL_RESEND_BASE_URL = "https://api.resend.com";

export const EMAIL_PROVIDER_TIMEOUT_MS_DEFAULT = 10_000;
export const EMAIL_PROVIDER_TIMEOUT_MS_MIN = 1_000;
export const EMAIL_PROVIDER_TIMEOUT_MS_MAX = 30_000;

/** Resend 幂等保留窗口 = 24h；本地安全窗口 = 23h（§26）。 */
export const EMAIL_IDEMPOTENCY_SAFE_WINDOW_HOURS = 23;
export const EMAIL_IDEMPOTENCY_SAFE_WINDOW_MS = EMAIL_IDEMPOTENCY_SAFE_WINDOW_HOURS * 60 * 60 * 1000;

// ============================================================
// RB06（Review Round 2）：NOTIFICATION_DELIVERY execution budget。
//
// EMAIL execution transaction 在 serialization boundary（delivery 行锁）
// 内完成 provider HTTP 调用，因此事务预算必须覆盖最坏 provider 超时：
//
//   EMAIL_DELIVERY_EXECUTION_TX_TIMEOUT_MS (60s)
//     > EMAIL_PROVIDER_TIMEOUT_MS_MAX (30s)
//       + 锁等待 / DB / render / config / commit safety budget（>=20s）
//     > 其它最慢合法同事务路径（account erasure 事务 ≈20s 同序）
//
//   EMAIL_DELIVERY_EXECUTION_LEASE_SECONDS (90s)
//     execution lease 必须 > execution transaction max + completion
//     safety margin（>=10s）：90_000 > 60_000 + 10_000——否则 COMMIT 后
//     completion marker 落库前即可能进入 expired-lease reclaim 窗口，
//     与 9A crash-recovery 合同冲突。
//
// 两个常量为静态不变量测试（EMAIL-TX-BUDGET-01 / EMAIL-LEASE-BUDGET-01）
// 的冻结基线；调整任一侧必须同步复核本注释的算术。
// ============================================================

export const EMAIL_DELIVERY_EXECUTION_TX_TIMEOUT_MS = 60_000;
export const EMAIL_DELIVERY_EXECUTION_LEASE_SECONDS = 90;

/**
 * 严格但现实的 email 地址校验（§42）：支持 "addr@domain" 与
 * "Display Name <addr@domain>" 两种形态，地址部分用 z.string().email()。
 * 绝不自写 RFC 巨型 regex。非法/缺失返回 null（调用方据此抑制 delivery）。
 */
export function extractEmailAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const angle = trimmed.match(/<([^<>]+)>\s*$/);
  const candidate = (angle ? angle[1]! : trimmed).trim();
  return z.string().email().safeParse(candidate).success ? candidate : null;
}
