import { z } from "zod";

import {
  USER_QUEUE_DEFAULT_PAGE_SIZE,
  USER_QUEUE_MAX_PAGE_SIZE,
} from "@/lib/governance/user-operations-query";

/**
 * Phase 7F：/governance/users 队列与操作的输入合同。
 *
 * - query params 全部 optional；空串视同未提供（7D 教训：GET 空串参数挂严格
 *   zod 会产生 hydration 双挂载假阳性）；
 * - cursor 是 base64url(JSON) 的 UNTRUSTED 分页位置：解析失败 → 安全失败态；
 * - suspend/reinstate action 只收 userId（server validated）；actor 身份一律
 *   来自 requireUser()，target 状态合法性由 canonical enforcement service
 *   锁内断言（幂等/privileged/self-deny）。
 */

export const userQueueLimitSchema = z.coerce
  .number()
  .int()
  .min(1, "limit 必须在 1 到 50 之间")
  .max(USER_QUEUE_MAX_PAGE_SIZE, "limit 必须在 1 到 50 之间");

export const userQueueFilterSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: userQueueLimitSchema.optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  verification: z
    .enum(["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED", "REVOKED"])
    .optional(),
  campus: z.string().trim().min(1).optional(),
});

export type UserQueueFilterInput = z.infer<typeof userQueueFilterSchema>;

export const governanceUserActionSchema = z.object({
  userId: z.string().trim().min(1, "缺少用户 id"),
});

export { USER_QUEUE_DEFAULT_PAGE_SIZE };
