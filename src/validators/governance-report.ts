import { z } from "zod";

import { REPORT_QUEUE_DEFAULT_PAGE_SIZE, REPORT_QUEUE_MAX_PAGE_SIZE } from "@/lib/reports/report-query";

/**
 * Phase 7E：/governance/reports 队列与操作的输入合同。
 *
 * - query params 全部 optional；空串视同未提供（7D 教训：GET 空串参数
 *   挂严格 zod 会产生 hydration 双挂载假阳性——present-but-empty 一律
 *   归一化为 undefined 后再校验）；
 * - cursor 是 base64url(JSON) 的 UNTRUSTED 分页位置：解析失败 → 安全失败态
 *   （由调用方决定空页/错误提示），安全性来自每条查询的授权分支集合，
 *   不来自 cursor 真实性；
 * - review action 的 status 枚举与 REPORT_STATUS_TRANSITIONS 的合法目标一致
 *   （OPEN 不可由客户端提交）；实际流转合法性由 applyReportReviewTx 在
 *   行锁内断言。
 */

export const reportQueueLimitSchema = z.coerce
  .number()
  .int()
  .min(1, "limit 必须在 1 到 50 之间")
  .max(REPORT_QUEUE_MAX_PAGE_SIZE, "limit 必须在 1 到 50 之间");

export const reportQueueFilterSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: reportQueueLimitSchema.optional(),
  campus: z.string().trim().min(1).optional(),
  status: z.enum(["OPEN", "IN_REVIEW", "RESOLVED", "REJECTED"]).optional(),
  targetType: z
    .enum(["PRODUCT", "ERRAND_TASK", "SERVICE_LISTING", "RENTAL_LISTING", "USER", "MESSAGE"])
    .optional(),
  reason: z
    .enum([
      "FAKE_INFO",
      "SCAM_RISK",
      "BANNED_ITEM",
      "ACADEMIC_CHEATING",
      "HARASSMENT",
      "ADVERTISEMENT",
      "PRICE_FRAUD",
      "OTHER",
    ])
    .optional(),
  assignment: z.enum(["mine", "unassigned", "all"]).optional(),
  overdue: z.enum(["1", "true"]).optional(),
});

export type ReportQueueFilterInput = z.infer<typeof reportQueueFilterSchema>;

/** governance review action（status 不含 OPEN——创建即 OPEN，无客户端路径）。 */
export const governanceReportReviewSchema = z.object({
  reportId: z.string().trim().min(1, "缺少举报 id"),
  status: z.enum(["IN_REVIEW", "RESOLVED", "REJECTED"]),
  handledNote: z
    .string()
    .trim()
    .max(300, "处理备注不能超过 300 个字")
    .optional()
    .transform((value) => value ?? ""),
});

export const governanceReportCaseSchema = z.object({
  reportId: z.string().trim().min(1, "缺少举报 id"),
});

export { REPORT_QUEUE_DEFAULT_PAGE_SIZE };
