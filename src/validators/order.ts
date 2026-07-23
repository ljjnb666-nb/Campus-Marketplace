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
