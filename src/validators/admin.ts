import { z } from "zod";

export const verificationReviewSchema = z.object({
  verificationId: z.string().trim().min(1),
  userId: z.string().trim().min(1),
  status: z.enum(["VERIFIED", "REJECTED"]),
  reviewNote: z
    .string()
    .trim()
    .max(200, "审核备注不能超过 200 个字")
    .optional()
    .transform((value) => value ?? ""),
});

export const reportReviewSchema = z.object({
  reportId: z.string().trim().min(1),
  status: z.enum(["IN_REVIEW", "RESOLVED", "REJECTED"]),
  handledNote: z
    .string()
    .trim()
    .max(300, "处理备注不能超过 300 个字")
    .optional()
    .transform((value) => value ?? ""),
});

export const toggleUserStatusSchema = z.object({
  userId: z.string().trim().min(1),
  nextStatus: z.enum(["ACTIVE", "SUSPENDED"]),
});

export const moderateListingSchema = z.object({
  targetType: z.enum(["PRODUCT", "ERRAND", "SERVICE"]),
  targetId: z.string().trim().min(1),
});

export const categoryFormSchema = z.object({
  categoryId: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1, "分类名称不能为空").max(30, "分类名称不能超过 30 个字"),
  slug: z.string().trim().min(1, "分类 slug 不能为空").max(40, "分类 slug 不能超过 40 个字符"),
  description: z
    .string()
    .trim()
    .max(120, "分类说明不能超过 120 个字")
    .optional()
    .transform((value) => value ?? ""),
  sortOrder: z.coerce
    .number()
    .int("排序必须是整数")
    .min(0, "排序不能小于 0")
    .max(999, "排序不能超过 999"),
  isActive: z.enum(["true", "false"]).transform((value) => value === "true"),
});

export const categoryStatusSchema = z.object({
  categoryId: z.string().trim().min(1),
  isActive: z.enum(["true", "false"]).transform((value) => value === "true"),
});

export const moderationKeywordSchema = z.object({
  keywordId: z.string().trim().min(1).optional(),
  keyword: z.string().trim().min(1, "关键词不能为空").max(40, "关键词不能超过 40 个字符"),
  targetType: z.enum(["PRODUCT", "ERRAND", "SERVICE", "MESSAGE", "GLOBAL"]),
  isEnabled: z.enum(["true", "false"]).transform((value) => value === "true"),
});

export const moderationKeywordStatusSchema = z.object({
  keywordId: z.string().trim().min(1),
  isEnabled: z.enum(["true", "false"]).transform((value) => value === "true"),
});
