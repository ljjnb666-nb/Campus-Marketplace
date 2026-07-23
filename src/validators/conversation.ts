import { z } from "zod";

export const productConversationSchema = z.object({
  productId: z.string().trim().min(1, "商品不存在"),
});

export const serviceConversationSchema = z.object({
  serviceId: z.string().trim().min(1, "服务不存在"),
});

export const errandConversationSchema = z.object({
  errandId: z.string().trim().min(1, "任务不存在"),
});

export const rentalConversationSchema = z.object({
  rentalListingId: z.string().trim().min(1, "租赁物品不存在"),
});

export const orderConversationSchema = z.object({
  orderId: z.string().trim().min(1, "订单不存在"),
  orderType: z.enum(["PRODUCT", "RENTAL"]).default("PRODUCT"),
});

export const sendMessageSchema = z.object({
  conversationId: z.string().trim().min(1, "会话不存在"),
  content: z.string().trim().min(1, "消息不能为空").max(1000, "消息不能超过 1000 个字"),
});

export const reportUserOrMessageSchema = z.object({
  targetUserId: z.string().trim().optional(),
  messageId: z.string().trim().optional(),
  conversationId: z.string().trim().min(1, "会话不存在"),
  reason: z.enum(["SPAM", "HARASSMENT", "FRAUD", "INAPPROPRIATE_CONTENT", "OTHER"]),
  detail: z.string().trim().max(500, "补充说明不超过500字").optional(),
});
