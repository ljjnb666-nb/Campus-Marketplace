import { z } from "zod";

import {
  SUPPORT_QUEUE_DEFAULT_PAGE_SIZE,
  SUPPORT_QUEUE_MAX_PAGE_SIZE,
} from "@/lib/support/support-query";

/**
 * Phase 7G：/governance/support 队列与操作的输入合同。
 *
 * - query params 全部 optional；空串视同未提供（7D 教训）；
 * - cursor 是 base64url(JSON) 的 UNTRUSTED 分页位置；
 * - resolutionMessage = USER_VISIBLE、internalNote = OPERATOR_ONLY——
 *   两个字段分离冻结，读面分别授权（requester 读面结构性不含 internalNote）。
 */

export const supportQueueLimitSchema = z.coerce
  .number()
  .int()
  .min(1, "limit 必须在 1 到 50 之间")
  .max(SUPPORT_QUEUE_MAX_PAGE_SIZE, "limit 必须在 1 到 50 之间");

export const supportQueueFilterSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: supportQueueLimitSchema.optional(),
  campus: z.string().trim().min(1).optional(),
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(),
  assignment: z.enum(["mine", "unassigned", "all"]).optional(),
  overdue: z.enum(["1", "true"]).optional(),
});

export type SupportQueueFilterInput = z.infer<typeof supportQueueFilterSchema>;

export const governanceSupportClaimSchema = z.object({
  ticketId: z.string().trim().min(1, "缺少工单 id"),
});

export const governanceSupportResolveSchema = z.object({
  ticketId: z.string().trim().min(1, "缺少工单 id"),
  resolutionCode: z.enum([
    "ANSWERED",
    "USER_GUIDED",
    "DUPLICATE",
    "INVALID",
    "OUT_OF_SCOPE",
    "OTHER",
  ]),
  resolutionMessage: z
    .string()
    .trim()
    .max(500, "处理结果说明不能超过 500 个字")
    .optional()
    .transform((value) => value ?? ""),
  internalNote: z
    .string()
    .trim()
    .max(500, "内部备注不能超过 500 个字")
    .optional()
    .transform((value) => value ?? ""),
});

export const governanceSupportCloseSchema = z.object({
  ticketId: z.string().trim().min(1, "缺少工单 id"),
  internalNote: z
    .string()
    .trim()
    .max(500, "内部备注不能超过 500 个字")
    .optional()
    .transform((value) => value ?? ""),
});

export { SUPPORT_QUEUE_DEFAULT_PAGE_SIZE };
