import { z } from "zod";

import {
  VERIFICATION_QUEUE_DEFAULT_PAGE_SIZE,
  VERIFICATION_QUEUE_MAX_PAGE_SIZE,
} from "@/lib/campus/verification-review-query";

/**
 * Phase 7F：/governance/verifications 队列与操作的输入合同。
 *
 * - query params 全部 optional；空串视同未提供（7D 教训）；
 * - cursor 是 base64url(JSON) 的 UNTRUSTED 分页位置：解析失败 → 安全失败态；
 * - review action 的 decision 只接受 canonical 状态机的合法治理目标
 *   （PENDING→VERIFIED/REJECTED、VERIFIED→REVOKED）；实际流转合法性由
 *   decideMembershipVerification 锁内断言（本 schema 不复制 transition table，
 *   只拒绝明显非法的输入）。
 */

export const verificationQueueLimitSchema = z.coerce
  .number()
  .int()
  .min(1, "limit 必须在 1 到 50 之间")
  .max(VERIFICATION_QUEUE_MAX_PAGE_SIZE, "limit 必须在 1 到 50 之间");

export const verificationQueueFilterSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: verificationQueueLimitSchema.optional(),
  campus: z.string().trim().min(1).optional(),
  status: z.enum(["PENDING", "VERIFIED", "REJECTED", "REVOKED"]).optional(),
  overdue: z.enum(["1", "true"]).optional(),
});

export type VerificationQueueFilterInput = z.infer<typeof verificationQueueFilterSchema>;

export const governanceVerificationReviewSchema = z.object({
  verificationId: z.string().trim().min(1, "缺少认证申请 id"),
  decision: z.enum(["VERIFIED", "REJECTED", "REVOKED"]),
  reviewNote: z
    .string()
    .trim()
    .max(200, "审核备注不能超过 200 个字")
    .optional()
    .transform((value) => value ?? ""),
  reasonCode: z
    .string()
    .trim()
    .max(64, "原因码不能超过 64 个字符")
    .regex(/^[A-Z0-9_]*$/, "原因码仅允许大写字母、数字与下划线")
    .optional()
    .transform((value) => value || undefined),
});

export { VERIFICATION_QUEUE_DEFAULT_PAGE_SIZE };
