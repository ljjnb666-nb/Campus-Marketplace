import { z } from "zod";

/**
 * Phase 7G：/support 用户面（创建支持工单）输入合同。
 *
 * .strict()：callerUserId/requesterId 等服务端所有字段被显式拒绝
 * （不做静默 strip——"ignore 不够安全"，与 6C-2 appealSubmit 同约定）。
 * SUPPORT_ATTACHMENTS = OUT_OF_SCOPE（指令冻结）：结构上不存在附件字段。
 */
export const supportTicketCreateSchema = z
  .object({
    category: z.enum(["ACCOUNT", "VERIFICATION", "MARKETPLACE", "SAFETY", "OTHER"]),
    subject: z
      .string()
      .trim()
      .min(2, "主题不能少于 2 个字")
      .max(100, "主题不能超过 100 个字"),
    description: z
      .string()
      .trim()
      .min(10, "问题描述不能少于 10 个字")
      .max(2000, "问题描述不能超过 2000 个字"),
    // 可选校区 scope：省略 = UNSCOPED；ACTIVE membership 由 canonical 服务在
    // USER:requester 锁内复核（禁止从 User.campusId 自动猜 scope）
    campusId: z.string().trim().min(1).optional(),
  })
  .strict();

export type SupportTicketCreateInput = z.infer<typeof supportTicketCreateSchema>;
