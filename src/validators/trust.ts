import { z } from "zod";

// Phase 8E（§29）：tags 结构化上限——不允许"总字符串 ≤ N"被几百个逗号
// 绕过成异常列表；trim / 去空 / 数量 / 单条长度全部显式冻结。
export const REVIEW_MAX_TAGS = 6;
export const REVIEW_MAX_TAG_LENGTH = 20;

export const reviewFormSchema = z.object({
  orderId: z.string().trim().min(1, "订单不存在"),
  // Phase 8E（§13）：targetUserId 不再属于客户端 authority——评价对象由
  // canonical service 从锁内 Order 行推导（actor == buyer → seller 等），
  // 恶意 FormData 注入 targetUserId / authorId 完全无效。
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
    .max(300, "标签内容过长")
    .optional()
    .transform((value) => value ?? "")
    .transform((value) =>
      value
        .split(/[，,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .refine((tags) => tags.length <= REVIEW_MAX_TAGS, {
      message: `标签最多 ${REVIEW_MAX_TAGS} 个`,
    })
    .refine((tags) => tags.every((tag) => tag.length <= REVIEW_MAX_TAG_LENGTH), {
      message: `单个标签不能超过 ${REVIEW_MAX_TAG_LENGTH} 个字`,
    })
    .transform((tags) => Array.from(new Set(tags))),
});

export const reportFormSchema = z.object({
  // Phase 7E rental repair：RENTAL_LISTING 纳入（与 ReportTargetType 全集一致）
  targetType: z.enum(["PRODUCT", "ERRAND_TASK", "SERVICE_LISTING", "RENTAL_LISTING", "USER", "MESSAGE"]),
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
  // 目标 id 字段来自 FormData.get()：字段缺席时返回 null（而非 undefined），
  // 必须 .nullable() 才能让“单目标举报”通过校验（举报商品时其余 id 为 null）
  productId: z.string().trim().nullable().optional().transform((value) => value ?? ""),
  errandTaskId: z.string().trim().nullable().optional().transform((value) => value ?? ""),
  serviceListingId: z.string().trim().nullable().optional().transform((value) => value ?? ""),
  rentalListingId: z.string().trim().nullable().optional().transform((value) => value ?? ""),
  targetUserId: z.string().trim().nullable().optional().transform((value) => value ?? ""),
  messageId: z.string().trim().nullable().optional().transform((value) => value ?? ""),
});
