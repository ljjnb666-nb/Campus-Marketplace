import { z } from "zod";

import { APPEAL_DECISION_NOTE_MAX_LENGTH } from "@/lib/appeals/appeal-service";

/**
 * Phase 7A 治理面（operator）Server Action 表单合同。
 *
 * - .strict()：reviewerId/actorId/campusId/scope 等安全敏感未知字段一律拒绝
 *   （不做静默 strip）——reviewer 身份永远来自服务端 session（§26 冻结）。
 * - decisionNote 复用域常量 APPEAL_DECISION_NOTE_MAX_LENGTH（1000），
 *   不另立冲突上限；域服务仍是权威。
 * - decision 仅允许人工输入 GRANTED | UPHELD：程序性 DISMISSED 是 canonical
 *   域服务计算的 committed 结局，operator 无权选择（§28 冻结）。
 */

export const governanceAppealBeginSchema = z
  .object({
    appealId: z.string().min(1, "缺少申诉标识"),
  })
  .strict();

export const governanceAppealDecisionSchema = z
  .object({
    appealId: z.string().min(1, "缺少申诉标识"),
    decision: z.enum(["GRANTED", "UPHELD"], { message: "决定类型无效" }),
    decisionNote: z
      .string()
      .trim()
      .max(
        APPEAL_DECISION_NOTE_MAX_LENGTH,
        `审核备注不能超过 ${APPEAL_DECISION_NOTE_MAX_LENGTH} 字`,
      )
      .optional(),
  })
  .strict();
