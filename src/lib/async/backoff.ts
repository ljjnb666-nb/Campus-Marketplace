/**
 * Phase 9A：统一 retry backoff 原语（§15）。
 *
 * 公式冻结：min(BASE * 2^(attempts - 1), MAX)。attempts = 实际 execution
 * claim 次数（第一次 claim 0 → 1，失败后按已消耗 attempts 计算）——
 * attempt 1 失败 → 5s，attempt 2 失败 → 10s，以此类推。
 *
 * 统一 helper：job / outbox 两套队列共用，禁止各 handler 自行计算。
 * 暂不要求 jitter（Phase 9 无多租户惊群风险）。
 */

export const BASE_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 15 * 60 * 1000;

export function computeBackoffDelayMs(attempts: number): number {
  const consumedAttempts = Math.max(1, Math.floor(attempts));
  return Math.min(BASE_BACKOFF_MS * 2 ** (consumedAttempts - 1), MAX_BACKOFF_MS);
}
