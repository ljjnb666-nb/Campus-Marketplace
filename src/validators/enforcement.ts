import { z } from "zod";

import type { EnforcementActionType } from "@prisma/client";

/**
 * Phase 7D：/governance/enforcement 队列/历史查询合同。
 *
 * - enforcementSeq 是 DB unique 的因果序（R6/DECISION_14 冻结）：cursor
 *   载荷为 canonical decimal string（^(0|[1-9][0-9]*)$），base64url 信封，
 *   encode(decode(cursor)) 唯一表示；负号/小数/科学计数/前导零/空串/坏
 *   base64url 一律拒绝（safe failure）。
 * - 禁止 Number(seq)（>2^53 精度丢失）与裸 BigInt 进 JSON。
 * - createdAt 仅展示：绝不参与 latest/causality/cursor/stale 判定
 *   （enforcement-sequence.ts 冻结合同）。
 */

export const ENFORCEMENT_DEFAULT_PAGE_SIZE = 25;
export const ENFORCEMENT_MAX_PAGE_SIZE = 50;

export const enforcementPageLimitSchema = z.coerce
  .number()
  .int()
  .min(1, "limit 必须在 1 到 50 之间")
  .max(ENFORCEMENT_MAX_PAGE_SIZE, "limit 必须在 1 到 50 之间");

export const ENFORCEMENT_QUEUE_TARGET_TYPES = [
  "MARKETPLACE_RESTRICT",
  "MARKETPLACE_RESTORE",
  "ACCOUNT_SUSPEND",
  "ACCOUNT_REINSTATE",
  "MEMBERSHIP_SUSPEND",
  "MEMBERSHIP_REINSTATE",
] as const satisfies readonly EnforcementActionType[];

export const enforcementQueueQuerySchema = z
  .object({
    limit: enforcementPageLimitSchema.optional(),
    cursor: z.string().min(1).optional(),
    campusId: z.string().min(1).max(64).optional(),
    type: z.enum(ENFORCEMENT_QUEUE_TARGET_TYPES).optional(),
    targetId: z.string().min(1).max(64).optional(),
    actorId: z.string().min(1).max(64).optional(),
    sourceType: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type EnforcementQueueQuery = z.infer<typeof enforcementQueueQuerySchema>;

export const enforcementTargetHistoryQuerySchema = z
  .object({
    limit: enforcementPageLimitSchema.optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export type EnforcementTargetHistoryQuery = z.infer<typeof enforcementTargetHistoryQuerySchema>;

/** canonical decimal string（R6 冻结）：无符号、无前导零、十进制。 */
export const ENFORCEMENT_SEQ_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

/** seq（bigint）→ canonical decimal string（DTO 与 cursor 载荷同一形式）。 */
export function encodeEnforcementSeq(seq: bigint): string {
  return seq.toString(10);
}

/** seq cursor → base64url(canonical decimal string)。 */
export function encodeEnforcementSeqCursor(seq: bigint): string {
  return Buffer.from(encodeEnforcementSeq(seq), "utf8").toString("base64url");
}

/**
 * 解码客户端回传的 seq cursor。任何格式偏离 canonical decimal 的输入
 * （负号/小数/科学计数/前导零/空串/坏 base64url）返回 null（调用方映射
 * 安全失败态）。成功返回 bigint，绝不经过 Number。
 */
export function decodeEnforcementSeqCursor(raw: string): bigint | null {
  let payload: string;
  try {
    payload = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }

  if (!ENFORCEMENT_SEQ_DECIMAL_PATTERN.test(payload)) {
    return null;
  }

  try {
    return BigInt(payload);
  } catch {
    return null;
  }
}
