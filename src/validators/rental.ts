import { z } from "zod";
import { isStoredImagePath } from "@/lib/upload";

const RENTAL_IMAGE_LIMIT = 9;

const imageUrlsSchema = z
  .array(
    z
      .string()
      .trim()
      .refine((value) => /^https?:\/\//.test(value) || isStoredImagePath(value), {
        message: "图片地址格式不正确",
      }),
  )
  .max(RENTAL_IMAGE_LIMIT, `最多上传 ${RENTAL_IMAGE_LIMIT} 张图片`);

export const rentalListingFormSchema = z.object({
  title: z.string().trim().min(4).max(60),
  description: z.string().trim().min(10).max(2000),
  categoryId: z.string().trim().min(1, "请选择物品分类"),
  condition: z.enum(["NEW", "LIKE_NEW", "LIGHTLY_USED", "NORMAL_USED", "HEAVILY_USED"]),
  brand: z.string().trim().max(50).optional(),
  model: z.string().trim().max(50).optional(),
  referenceValue: z.string().trim().optional().transform(v => v ?? "").refine(v => v === "" || (!isNaN(Number(v)) && Number(v) >= 0), { message: "估值格式不正确" }),
  price: z.string().trim().min(1, "租金必填").refine(v => !isNaN(Number(v)) && Number(v) >= 0, { message: "租金格式不正确" }),
  pricingUnit: z.enum(["PER_HOUR", "PER_DAY", "PER_WEEK", "PER_MONTH", "PER_SESSION"]),
  depositAmount: z.string().trim().min(1, "押金必填").refine(v => !isNaN(Number(v)) && Number(v) >= 0, { message: "押金格式不正确" }),
  minimumDuration: z.string().trim().refine(v => Number.isInteger(Number(v)) && Number(v) >= 1, { message: "最短租期至少为1" }),
  maximumDuration: z.string().trim().refine(v => Number.isInteger(Number(v)) && Number(v) >= 1, { message: "最长租期至少为1" }),
  totalQuantity: z.string().trim().default("1").refine(v => Number.isInteger(Number(v)) && Number(v) >= 1, { message: "数量至少1" }),
  pickupLocation: z.string().trim().min(2).max(100),
  returnLocation: z.string().trim().min(2).max(100),
  usageRules: z.string().trim().max(500).optional(),
  damagePolicy: z.string().trim().max(500).optional(),
  overduePolicy: z.string().trim().max(500).optional(),
  requiresApproval: z.string().optional().transform(v => v === "true" || v === "on" || v === "1"),
  imageUrls: imageUrlsSchema,
});

export const rentalOrderCreateSchema = z.object({
  rentalListingId: z.string().trim().min(1),
  startTime: z.string().trim().min(1, "请选择开始时间"),
  endTime: z.string().trim().min(1, "请选择结束时间"),
  quantity: z.string().trim().default("1"),
  renterNote: z.string().trim().max(200).optional(),
});

export const rentalExtensionSchema = z.object({
  orderId: z.string().trim().min(1),
  newEndTime: z.string().trim().min(1, "请选择新结束时间"),
});

export const rentalDamageClaimSchema = z.object({
  orderId: z.string().trim().min(1),
  damageDescription: z.string().trim().min(5).max(1000),
  requestedDeduction: z.string().trim().refine(v => !isNaN(Number(v)) && Number(v) >= 0),
});

export const rentalReviewSchema = z.object({
  orderId: z.string().trim().min(1),
  overallRating: z.coerce.number().int().min(1).max(5),
  content: z.string().trim().max(500).optional(),
  tags: z.array(z.string()).default([]),
  itemMatchDesc: z.coerce.number().int().min(1).max(5).optional(),
  itemWorksWell: z.coerce.number().int().min(1).max(5).optional(),
  ownerResponsive: z.coerce.number().int().min(1).max(5).optional(),
  pickupEasy: z.coerce.number().int().min(1).max(5).optional(),
  attitudeFriendly: z.coerce.number().int().min(1).max(5).optional(),
  returnedOnTime: z.coerce.number().int().min(1).max(5).optional(),
  itemWellKept: z.coerce.number().int().min(1).max(5).optional(),
  accessoriesComplete: z.coerce.number().int().min(1).max(5).optional(),
  goodCommunication: z.coerce.number().int().min(1).max(5).optional(),
  reliable: z.coerce.number().int().min(1).max(5).optional(),
});

export type RentalListingFormInput = z.infer<typeof rentalListingFormSchema>;
export type RentalOrderCreateInput = z.infer<typeof rentalOrderCreateSchema>;
