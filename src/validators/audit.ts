import { z } from "zod";

/**
 * Phase 7D：/governance/audit 队列查询合同（GET searchParams 校验）。
 *
 * - cursor 是 base64url(JSON) 的 UNTRUSTED PAGINATION POSITION（沿 7A
 *   validators/appeal.ts 先例）：解码失败 → null → 页面安全失败态；
 * - 页大小 default 25 / max 50 / take limit+1（7A/7B/7C 同构）；
 * - 日期过滤冻结为 YYYY-MM-DD → UTC 全天边界（确定性、测试时区无关）。
 */

export const AUDIT_DEFAULT_PAGE_SIZE = 25;
export const AUDIT_MAX_PAGE_SIZE = 50;

export const auditPageLimitSchema = z.coerce
  .number()
  .int()
  .min(1, "limit 必须在 1 到 50 之间")
  .max(AUDIT_MAX_PAGE_SIZE, "limit 必须在 1 到 50 之间");

/**
 * 真实 UTC 日历日期校验（Final Review Repair 1 / FR03 冻结）：
 * 形状 ^\d{4}-\d{2}-\d{2}$ 且为真实存在的 UTC 日历日（ISO 往返一致）。
 * 拒绝 2026-02-30 / 2026-13-01 / 2026-00-01 / 非闰年 02-29 等不可能日期，
 * 使 Invalid Date 结构性无法进入 Prisma。
 */
export function isCanonicalUtcDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const auditDateSchema = z
  .string()
  .refine(isCanonicalUtcDate, "日期必须为真实 UTC 日历日期（YYYY-MM-DD）");

export const auditQueueQuerySchema = z
  .object({
    limit: auditPageLimitSchema.optional(),
    cursor: z.string().min(1).optional(),
    campusId: z.string().min(1).max(64).optional(),
    actorId: z.string().min(1).max(64).optional(),
    targetType: z.string().trim().min(1).max(64).optional(),
    action: z.string().trim().min(1).max(96).optional(),
    from: auditDateSchema.optional(),
    to: auditDateSchema.optional(),
  })
  .strict();

export type AuditQueueQuery = z.infer<typeof auditQueueQuerySchema>;

export type AuditCursor = { createdAt: Date; id: string };

const auditCursorPayloadSchema = z
  .object({
    createdAt: z.iso.datetime({ message: "cursor 无效" }),
    id: z.string().min(1, "cursor 无效"),
  })
  .strict();

/** 由实际返回的最后一条 item 生成下一页 cursor（base64url(JSON)，7A 同构）。 */
export function encodeAuditCursor(cursor: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
  ).toString("base64url");
}

/**
 * 解码客户端回传的 cursor。任何解析/校验失败返回 null（调用方映射安全失败态）。
 * cursor 只是分页位置：scope 过滤独立 AND，伪造 cursor 只能改变位置，
 * 永远改变不了授权范围。
 */
export function decodeAuditCursor(raw: string): AuditCursor | null {
  let payload: unknown;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    return null;
  }

  const parsed = auditCursorPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }

  const createdAt = new Date(parsed.data.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  return { createdAt, id: parsed.data.id };
}

/**
 * from/to → createdAt 区间（UTC 全天，v1 冻结边界语义）。调用方必须先经
 * auditQueueQuerySchema（内置 isCanonicalUtcDate）校验——本 helper 是
 * 日期→UTC range 的唯一构造点，读模型不得自行重复构造（防语义漂移）。
 * 索引友好：与 (createdAt, id)/(campusId, createdAt, id) 复合索引前缀一致。
 */
export function auditDateRange(from?: string, to?: string): { gte?: Date; lte?: Date } {
  const range: { gte?: Date; lte?: Date } = {};
  if (from && isCanonicalUtcDate(from)) {
    range.gte = new Date(`${from}T00:00:00.000Z`);
  }
  if (to && isCanonicalUtcDate(to)) {
    range.lte = new Date(`${to}T23:59:59.999Z`);
  }
  return range;
}
