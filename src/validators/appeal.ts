import { z } from "zod";

import { APPEAL_STATEMENT_MAX_LENGTH } from "@/lib/appeals/appeal-service";

/**
 * Phase 6C-2 Appeal HTTP 合同（Planning 冻结）。
 *
 * - submit body 用 .strict()：callerUserId/userId/appellantId/targetUserId 等
 *   安全敏感未知字段一律 400 拒绝（不做静默 strip——"ignore 不够安全"）。
 * - cursor 是 base64url(JSON) 的 UNTRUSTED PAGINATION POSITION，不是签名
 *   token：解析失败 → 400；结构合法的自构造 cursor 允许进入 keyset 条件，
 *   安全性来自每条查询 targetId = session user（不来自 cursor 真实性）。
 */

export const APPEAL_SUBMIT_BODY_MAX_BYTES = 8 * 1024;

export const appealSubmitSchema = z
  .object({
    enforcementActionId: z.string().min(1, "缺少申诉目标"),
    statement: z
      .string()
      .trim()
      .min(1, "申诉内容不能为空")
      .max(APPEAL_STATEMENT_MAX_LENGTH, `申诉内容不能超过 ${APPEAL_STATEMENT_MAX_LENGTH} 字`),
  })
  .strict();

// ── eligible-actions 分页参数 ────────────────────────────────────────────────

export const APPEAL_DEFAULT_PAGE_SIZE = 25;
export const APPEAL_MAX_PAGE_SIZE = 50;

/** 缺席 → 默认页大小；非法（非整数 / 越界）→ 调用方 400。 */
export const appealPageLimitSchema = z.coerce
  .number()
  .int()
  .min(1, "limit 必须在 1 到 50 之间")
  .max(APPEAL_MAX_PAGE_SIZE, "limit 必须在 1 到 50 之间");

export const appealCursorPayloadSchema = z
  .object({
    createdAt: z.iso.datetime({ message: "cursor 无效" }),
    id: z.string().min(1, "cursor 无效"),
  })
  .strict();

export type AppealCursor = { createdAt: Date; id: string };

/** 由实际返回的最后一条 item 生成下一页 cursor（base64url(JSON)）。 */
export function encodeAppealCursor(cursor: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
  ).toString("base64url");
}

/**
 * 解码客户端回传的 cursor。任何解析/校验失败返回 null（调用方映射 400），
 * 成功则返回进入 keyset 条件用的 UNTRUSTED 分页位置。
 */
export function decodeAppealCursor(raw: string): AppealCursor | null {
  let payload: unknown;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    return null;
  }

  const parsed = appealCursorPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }

  const createdAt = new Date(parsed.data.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  return { createdAt, id: parsed.data.id };
}
