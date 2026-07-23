import { z } from "zod";

export const reviewFormSchema = z.object({
  orderId: z.string().trim().min(1, "订单不存在"),
  targetUserId: z.string().trim().min(1, "评价对象不存在"),
  rating: z.string().trim().refine((value) => ["1", "2", "3", "4", "5"].includes(value), {
    message: "评分必须在 1 到 5 之间",
  }),
  content: z
    .string()
    .trim()
    .max(300, "评价内容不能超过 300 个字")
    .optional()
    .transform((value) => value ?? ""),
  tags: z
    .string()
    .trim()
    .max(100, "标签不能超过 100 个字")
    .optional()
    .transform((value) => value ?? ""),
});

export const reportFormSchema = z.object({
  targetType: z.enum(["PRODUCT", "ERRAND_TASK", "SERVICE_LISTING", "USER", "MESSAGE"]),
  reason: z.enum([
    "FAKE_INFO",
    "SCAM_RISK",
    "BANNED_ITEM",
    "ACADEMIC_CHEATING",
    "HARASSMENT",
    "ADVERTISEMENT",
    "PRICE_FRAUD",
    "OTHER",
  ]),
  detail: z
    .string()
    .trim()
    .max(500, "举报说明不能超过 500 个字")
    .optional()
    .transform((value) => value ?? ""),
  productId: z.string().trim().optional().transform((value) => value ?? ""),
  errandTaskId: z.string().trim().optional().transform((value) => value ?? ""),
  serviceListingId: z.string().trim().optional().transform((value) => value ?? ""),
  targetUserId: z.string().trim().optional().transform((value) => value ?? ""),
  messageId: z.string().trim().optional().transform((value) => value ?? ""),
});
