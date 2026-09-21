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
 * - 全部 schema 服务端所有身份字段（campusId/policyId）只允许 hidden
 *   input 回传 id 值，任何授权/校验真相都在 canonical service 锁内重读。
 *
 * Final Review Repair 1 冻结：
 * - FR02 district 归一化在 validator boundary 完成：HTML 空串/纯空白 →
 *   null；canonical 输入 = undefined | null | trim 后非空且 <=80 的字符串；
 * - FR03 effectiveAt 只接受带时区的绝对 ISO 时间戳（Z 或 ±HH:MM offset，
 *   秒必需）——timezone-less datetime-local 文本（如 2026-09-22T09:00）
 *   fail closed 拒绝；浏览器负责在提交前把本地时间转换为绝对 ISO
 *   （hidden effectiveAt），可见输入仅是本地展示，不是 authority。
 */

const CAMPUS_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const governanceCampusListLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(CAMPUS_LIST_MAX_PAGE_SIZE);

/**
 * FR02：district 归一化（canonical 输入 = undefined | null | trim 后
 * 非空且 <=80 的字符串）。三态语义：
 *   字段缺席（直接 service 调用）→ undefined（不触碰该字段）；
 *   HTML 空串 / 纯空白 → null（显式清空语义）；
 *   非空 → trim 后字符串。长度校验作用于 trim 后的值（DISTRICT-05 保留）。
 */
const governanceDistrictSchema = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  })
  .refine((value) => value === undefined || value === null || value.length <= 80, {
    message: "所在区域不能超过 80 个字",
  });

export const governanceCampusCreateSchema = z.object({
  name: z.string().trim().min(1, "校区名称不能为空").max(64, "校区名称不能超过 64 个字"),
  slug: z
    .string()
    .trim()
    .min(1, "校区标识符不能为空")
    .max(64, "校区标识符不能超过 64 个字符")
    .regex(CAMPUS_SLUG_PATTERN, "仅允许小写字母、数字与连字符（不能以连字符开头或结尾）"),
  schoolName: z.string().trim().min(1, "学校名称不能为空").max(80, "学校名称不能超过 80 个字"),
  district: governanceDistrictSchema,
});

export const governanceCampusUpdateSchema = z
  .object({
    campusId: z.string().trim().min(1, "缺少校区 id"),
    name: z.string().trim().min(1, "校区名称不能为空").max(64, "校区名称不能超过 64 个字").optional(),
    schoolName: z.string().trim().min(1, "学校名称不能为空").max(80, "学校名称不能超过 80 个字").optional(),
    district: governanceDistrictSchema,
  })
  .refine(
    (data) => data.name !== undefined || data.schoolName !== undefined || data.district !== undefined,
    { message: "至少填写一项要修改的内容" },
  );

export const governanceCampusToggleSchema = z.object({
  campusId: z.string().trim().min(1, "缺少校区 id"),
});

/**
 * FR03：effectiveAt 只接受带时区的绝对 ISO 时间戳（秒必需，Z 或
 * ±HH:MM offset；缺省精确到毫秒）。timezone-less 形态（datetime-local
 * 的 "YYYY-MM-DDTHH:mm" 或无 Z 的秒级文本）一律 fail closed。
 * offset 形态在 parse 时被 canonicalize 为同一绝对 instant（Date）。
 */
const ABSOLUTE_ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;

const governanceEffectiveAtSchema = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed.length === 0) {
      return undefined;
    }
    if (!ABSOLUTE_ISO_TIMESTAMP_PATTERN.test(trimmed)) {
      return null;
    }
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  })
  .refine((value) => value !== null, {
    message: "生效时间必须是带时区的绝对 ISO 时间戳（如 2026-09-22T01:00:00.000Z）",
  });

export const governancePolicyDraftCreateSchema = z.object({
  campusId: z.string().trim().min(1, "缺少校区 id"),
  title: z.string().trim().min(1, "策略标题不能为空").max(120, "策略标题不能超过 120 个字"),
  instructions: z
    .string()
    .trim()
    .min(1, "认证说明不能为空")
    .max(5000, "认证说明不能超过 5000 个字"),
  effectiveAt: governanceEffectiveAtSchema,
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
  effectiveAt: governanceEffectiveAtSchema,
});

export const governancePolicyPublishSchema = z.object({
  campusId: z.string().trim().min(1, "缺少校区 id"),
  policyId: z.string().trim().min(1, "缺少策略 id"),
});

export const governancePolicyRetireSchema = z.object({
  campusId: z.string().trim().min(1, "缺少校区 id"),
  policyId: z.string().trim().min(1, "缺少策略 id"),
});
