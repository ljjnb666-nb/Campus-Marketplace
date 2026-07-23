import { z } from "zod";
import { isStoredImagePath } from "@/lib/upload";

const decimalString = z
  .string()
  .trim()
  .min(1, "价格不能为空")
  .refine((value) => !Number.isNaN(Number(value)) && Number(value) >= 0, {
    message: "价格必须是大于等于 0 的数字",
  });

const optionalImage = z
  .string()
  .trim()
  .optional()
  .transform((value) => value ?? "")
  .refine((value) => value === "" || /^https?:\/\//.test(value) || isStoredImagePath(value), {
    message: "封面图请填写合法的图片地址",
  });

export const serviceFormSchema = z.object({
  title: z.string().trim().min(4, "标题至少 4 个字").max(60, "标题不能超过 60 个字"),
  description: z
    .string()
    .trim()
    .min(10, "服务描述至少 10 个字")
    .max(1500, "服务描述不能超过 1500 个字"),
  categoryId: z.string().trim().min(1, "请选择服务分类"),
  price: decimalString,
  pricingUnit: z.enum(["PER_SESSION", "PER_HOUR", "PER_ORDER", "NEGOTIABLE"]),
  locationText: z
    .string()
    .trim()
    .min(2, "服务地点至少 2 个字")
    .max(50, "服务地点不能超过 50 个字"),
  availableSchedule: z
    .string()
    .trim()
    .max(300, "服务时间说明不能超过 300 个字")
    .optional()
    .transform((value) => value ?? ""),
  coverImageUrl: optionalImage,
});

export const serviceStatusSchema = z.object({
  serviceId: z.string().trim().min(1),
  status: z.enum(["ACTIVE", "PAUSED", "OFFLINE"]),
});

export type ServiceFormInput = z.infer<typeof serviceFormSchema>;
