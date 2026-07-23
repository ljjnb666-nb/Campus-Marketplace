import { z } from "zod";

const decimalString = z
  .string()
  .trim()
  .min(1, "金额必填")
  .refine((value) => !Number.isNaN(Number(value)) && Number(value) >= 0, {
    message: "金额必须是大于等于 0 的数字",
  });

export const errandFormSchema = z.object({
  title: z.string().trim().min(4, "标题至少 4 个字符").max(60, "标题不能超过 60 个字符"),
  description: z
    .string()
    .trim()
    .min(10, "描述至少 10 个字符")
    .max(1000, "描述不能超过 1000 个字符"),
  categoryId: z.string().trim().min(1, "请选择任务分类"),
  reward: decimalString,
  pickupLocation: z
    .string()
    .trim()
    .min(2, "取件地点至少 2 个字符")
    .max(50, "取件地点不能超过 50 个字符"),
  deliveryLocation: z
    .string()
    .trim()
    .min(2, "送达地点至少 2 个字符")
    .max(50, "送达地点不能超过 50 个字符"),
  deadline: z.string().trim().min(1, "截止时间必填"),
  contactNote: z
    .string()
    .trim()
    .max(200, "联系说明不能超过 200 个字符")
    .optional()
    .transform((value) => value ?? ""),
  needsAdvancePay: z.enum(["true", "false"]),
  advanceAmount: z
    .string()
    .trim()
    .optional()
    .transform((value) => value ?? "")
    .refine((value) => value === "" || (!Number.isNaN(Number(value)) && Number(value) >= 0), {
      message: "垫付金额必须是大于等于 0 的数字",
    }),
});

export const errandStatusSchema = z.object({
  errandId: z.string().trim().min(1),
  status: z.enum([
    "OPEN",
    "CLAIMED",
    "IN_PROGRESS",
    "PENDING_CONFIRMATION",
    "COMPLETED",
    "CANCELLED",
  ]),
});

export type ErrandFormInput = z.infer<typeof errandFormSchema>;
