import { z } from "zod";

const meetingLocationSchema = z
  .string()
  .trim()
  .min(2, "见面地点至少 2 个字")
  .max(80, "见面地点不能超过 80 个字");

const optionalNoteSchema = z
  .string()
  .trim()
  .max(300, "备注不能超过 300 个字")
  .optional()
  .transform((value) => value ?? "");

export const productOrderFormSchema = z.object({
  productId: z.string().trim().min(1, "商品不存在"),
  meetingLocation: meetingLocationSchema,
  note: optionalNoteSchema,
});

export const serviceOrderFormSchema = z.object({
  serviceId: z.string().trim().min(1, "服务不存在"),
  meetingLocation: meetingLocationSchema,
  note: optionalNoteSchema,
});

export const orderStatusSchema = z.object({
  orderId: z.string().trim().min(1),
  status: z.enum(["ACCEPTED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
});

/**
 * Phase 8C-02：General Order dispute（PRODUCT/SERVICE/ERRAND）用户输入合同。
 * reason contract 与 Rental 对齐（min 5 / max 1000），但不共用 Rental
 * validator——两个领域不同 aggregate。evidence 上传未开放：不设该字段。
 */
export const orderDisputeSchema = z.object({
  orderId: z.string().trim().min(1, "订单不存在"),
  reason: z
    .string()
    .trim()
    .min(5, "请填写纠纷原因（至少5个字）")
    .max(1000, "纠纷原因不能超过1000字"),
});
