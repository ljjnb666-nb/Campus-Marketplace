import { z } from "zod";

import {
  CAMPUS_LIST_MAX_PAGE_SIZE,
} from "@/lib/campus/campus-governance-query";

/**
 * Phase 7H：/governance/campuses 面的输入合同。
 *
 * - slug 冻结格式（§26）：小写字母/数字、连字符分段；仅 create 接受，
 *   update schema 结构性不含 slug 字段（slug IMMUTABLE，§27）；
 * - policy draft：客户端绝不指定 version（§33 服务器锁内顺序分配）；
 *   effectiveAt 接受 datetime-local 文本，服务器解析为 Date；
 * - 全部 schema 服务端所有身份字段（campusId/policyId）只允许 hidden
 *   input 回传 id 值，任何授权/校验真相都在 canonical service 锁内重读。
 */

const CAMPUS_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const governanceCampusListLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(CAMPUS_LIST_MAX_PAGE_SIZE);

export const governanceCampusCreateSchema = z.object({
  name: z.string().trim().min(1, "校区名称不能为空").max(64, "校区名称不能超过 64 个字"),
  slug: z
    .string()
    .trim()
    .min(1, "校区标识符不能为空")
    .max(64, "校区标识符不能超过 64 个字符")
    .regex(CAMPUS_SLUG_PATTERN, "仅允许小写字母、数字与连字符（不能以连字符开头或结尾）"),
  schoolName: z.string().trim().min(1, "学校名称不能为空").max(80, "学校名称不能超过 80 个字"),
  district: z.string().trim().max(80, "所在区域不能超过 80 个字").optional(),
});

export const governanceCampusUpdateSchema = z
  .object({
    campusId: z.string().trim().min(1, "缺少校区 id"),
    name: z.string().trim().min(1, "校区名称不能为空").max(64, "校区名称不能超过 64 个字").optional(),
    schoolName: z.string().trim().min(1, "学校名称不能为空").max(80, "学校名称不能超过 80 个字").optional(),
    district: z.string().trim().max(80, "所在区域不能超过 80 个字").optional(),
  })
  .refine(
    (data) => data.name !== undefined || data.schoolName !== undefined || data.district !== undefined,
    { message: "至少填写一项要修改的内容" },
  );

export const governanceCampusToggleSchema = z.object({
  campusId: z.string().trim().min(1, "缺少校区 id"),
});

function parseEffectiveAt(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const governancePolicyDraftCreateSchema = z.object({
  campusId: z.string().trim().min(1, "缺少校区 id"),
  title: z.string().trim().min(1, "策略标题不能为空").max(120, "策略标题不能超过 120 个字"),
  instructions: z
    .string()
    .trim()
    .min(1, "认证说明不能为空")
    .max(5000, "认证说明不能超过 5000 个字"),
  effectiveAt: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? parseEffectiveAt(value) : undefined))
    .refine((value) => value === undefined || value !== null, {
      message: "生效时间格式不合法",
    }),
});

export const governancePolicyDraftUpdateSchema = z.object({
  campusId: z.string().trim().min(1, "缺少校区 id"),
  policyId: z.string().trim().min(1, "缺少策略 id"),
  title: z.string().trim().min(1, "策略标题不能为空").max(120, "策略标题不能超过 120 个字").optional(),
  instructions: z
    .string()
    .trim()
    .min(1, "认证说明不能为空")
    .max(5000, "认证说明不能超过 5000 个字")
    .optional(),
  effectiveAt: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? parseEffectiveAt(value) : undefined))
    .refine((value) => value === undefined || value !== null, {
      message: "生效时间格式不合法",
    }),
});

export const governancePolicyPublishSchema = z.object({
  campusId: z.string().trim().min(1, "缺少校区 id"),
  policyId: z.string().trim().min(1, "缺少策略 id"),
});

export const governancePolicyRetireSchema = z.object({
  campusId: z.string().trim().min(1, "缺少校区 id"),
  policyId: z.string().trim().min(1, "缺少策略 id"),
});
