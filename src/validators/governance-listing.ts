import { z } from "zod";

/**
 * Phase 7C listing 治理面 action / pagination 合同（Planning Repair 1/2 冻结）。
 *
 * - .strict()：moderationId/ownerId/campusId/moderatorId/roleKey 等
 *   服务端所有字段一律拒绝（不做静默 strip——与 7B/6C-2 同约定）；
 * - takedown 客户端只提交 { listingId, reasonCode, note? }：type 由
 *   server-owned typed action 固定（四域各自独立 action，客户端不能选择
 *   targetType）；campusId/ownerId/现势状态全部由服务器锁内解析；
 * - restore 客户端只提交 { moderationId, expectedListingUpdatedAt }：
 *   target identity 由服务器从 moderation 行解析（R2-03）；
 * - reasonCode = strict enum（ListingModerationReasonCode 五值）；note =
 *   trim + ≤500（governance internal，不返回 owner）；
 * - cursor 是 base64url(JSON) 的 UNTRUSTED 分页位置，解析失败 → null
 *   （调用方安全失败态）；scope 授权独立于 cursor。
 */

export const LISTING_MODERATION_NOTE_MAX_LENGTH = 500;

export const LISTING_MODERATION_REASON_CODES = [
  "PROHIBITED_ITEM",
  "FRAUD_DECEPTION",
  "SPAM_ADVERTISEMENT",
  "CONTENT_VIOLATION",
  "OTHER",
] as const;

export const listingModerationTakedownSchema = z
  .object({
    listingId: z.string().min(1, "参数无效"),
    reasonCode: z.enum(LISTING_MODERATION_REASON_CODES),
    note: z
      .string()
      .trim()
      .max(LISTING_MODERATION_NOTE_MAX_LENGTH, `备注不能超过 ${LISTING_MODERATION_NOTE_MAX_LENGTH} 字`)
      .optional(),
  })
  .strict();

export const listingModerationRestoreSchema = z
  .object({
    moderationId: z.string().min(1, "参数无效"),
    expectedListingUpdatedAt: z.iso.datetime({ message: "参数无效" }),
  })
  .strict();

/** 缺席 → 默认页大小；非法（非整数 / 越界）→ 调用方安全回退默认值。 */
export const LISTING_MODERATION_DEFAULT_PAGE_SIZE = 25;
export const LISTING_MODERATION_MAX_PAGE_SIZE = 50;

export const listingModerationPageLimitSchema = z.coerce
  .number()
  .int()
  .min(1, "limit 必须在 1 到 50 之间")
  .max(LISTING_MODERATION_MAX_PAGE_SIZE, "limit 必须在 1 到 50 之间");

/** 浏览检视 tab 的 type 过滤（缺省 = 全部；非法值由调用方安全回退）。 */
export const listingModerationTypeFilterSchema = z.enum([
  "PRODUCT",
  "SERVICE",
  "ERRAND",
  "RENTAL",
]);

const listingModerationCursorPayloadSchema = z
  .object({
    createdAt: z.iso.datetime({ message: "cursor 无效" }),
    id: z.string().min(1, "cursor 无效"),
  })
  .strict();

export type ListingModerationCursor = { createdAt: Date; id: string };

/** 由实际返回的最后一条 item 生成下一页 cursor（base64url(JSON)）。 */
export function encodeListingModerationCursor(cursor: {
  createdAt: Date;
  id: string;
}): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
  ).toString("base64url");
}

/**
 * 解码客户端回传的 cursor。任何解析/校验失败（含非法时间戳/缺 id/任意
 * base64）返回 null（调用方映射安全失败态）。
 */
export function decodeListingModerationCursor(raw: string): ListingModerationCursor | null {
  let payload: unknown;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    return null;
  }

  const parsed = listingModerationCursorPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }

  const createdAt = new Date(parsed.data.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  return { createdAt, id: parsed.data.id };
}
