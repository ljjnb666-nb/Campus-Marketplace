import { z } from "zod";

import {
  DISPUTE_QUEUE_DEFAULT_PAGE_SIZE,
  DISPUTE_QUEUE_MAX_PAGE_SIZE,
} from "@/lib/disputes/dispute-query";

/**
 * Phase 7G：/governance/disputes 队列与操作的输入合同。
 *
 * - query params 全部 optional；空串视同未提供（7D 教训：GET 空串参数
 *   挂严格 zod 会产生 hydration 双挂载严格校验假阳性）；
 * - cursor 是 base64url(JSON) 的 UNTRUSTED 分页位置：解析失败 → 安全失败态
 *   （由调用方决定空页/错误提示），安全性来自每条查询的授权分支集合；
 * - resolve/close 的枚举与 DisputeResolutionCode / DisputeResolutionAction
 *   一致；实际流转合法性 / RESTORE_PREVIOUS 可用性由 canonical 服务在行锁内
 *   断言（OPEN 不可由客户端提交——创建即 OPEN）。
 */

export const disputeQueueLimitSchema = z.coerce
  .number()
  .int()
  .min(1, "limit 必须在 1 到 50 之间")
  .max(DISPUTE_QUEUE_MAX_PAGE_SIZE, "limit 必须在 1 到 50 之间");

export const disputeQueueFilterSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: disputeQueueLimitSchema.optional(),
  campus: z.string().trim().min(1).optional(),
  status: z.enum(["OPEN", "IN_REVIEW", "RESOLVED", "CLOSED"]).optional(),
  assignment: z.enum(["mine", "unassigned", "all"]).optional(),
  overdue: z.enum(["1", "true"]).optional(),
});

export type DisputeQueueFilterInput = z.infer<typeof disputeQueueFilterSchema>;

/**
 * Phase 8C-02：governance dispute 操作/队列的显式 discriminator。
 * RentalDispute 与 OrderDispute 是两个独立 aggregate——禁止通过 ID 格式 /
 * Order type 猜测 / 查表先后推断。
 * 旧 Rental form contract 兼容：missing → RENTAL（undefined 时生效）；
 * 所有新渲染 form 必须显式提交；非法值（非 null 且不在枚举内）parse 失败，
 * 由 action 映射统一 deny。
 */
export const governanceDisputeKindSchema = z.enum(["RENTAL", "ORDER"]).default("RENTAL");

export type GovernanceDisputeKindInput = z.infer<typeof governanceDisputeKindSchema>;

export const governanceDisputeClaimSchema = z.object({
  disputeId: z.string().trim().min(1, "缺少纠纷 id"),
});

export const governanceDisputeResolveSchema = z.object({
  disputeId: z.string().trim().min(1, "缺少纠纷 id"),
  resolutionCode: z.enum([
    "MUTUAL_AGREEMENT",
    "OPERATIONAL_REMEDIATION",
    "EVIDENCE_INSUFFICIENT",
    "DUPLICATE",
    "INVALID",
    "OTHER",
  ]),
  resolutionAction: z.enum(["RESTORE_PREVIOUS", "CLOSE_ORDER"]),
  adminNote: z
    .string()
    .trim()
    .max(500, "操作备注不能超过 500 个字")
    .optional()
    .transform((value) => value ?? ""),
});

export const governanceDisputeCloseSchema = z.object({
  disputeId: z.string().trim().min(1, "缺少纠纷 id"),
  resolutionAction: z.enum(["RESTORE_PREVIOUS", "CLOSE_ORDER"]),
  adminNote: z
    .string()
    .trim()
    .max(500, "操作备注不能超过 500 个字")
    .optional()
    .transform((value) => value ?? ""),
});

export { DISPUTE_QUEUE_DEFAULT_PAGE_SIZE };
