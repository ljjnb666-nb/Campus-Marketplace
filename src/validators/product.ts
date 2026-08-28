import { z } from "zod";
import { PRODUCT_IMAGE_LIMIT } from "@/constants/product";
import { isManageableImageValue } from "@/lib/asset-ref";

const priceSchema = z
  .string()
  .trim()
  .min(1, "价格必填")
  .refine((value) => !Number.isNaN(Number(value)) && Number(value) >= 0, {
    message: "价格必须是大于等于 0 的数字",
  });

const optionalPriceSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) => value ?? "")
  .refine((value) => value === "" || (!Number.isNaN(Number(value)) && Number(value) >= 0), {
    message: "原价必须是大于等于 0 的数字",
  });

const imageUrlsSchema = z
  .array(
    z
      .string()
      .trim()
      .refine((value) => isManageableImageValue(value), {
        message: "图片地址格式不正确",
      }),
  )
  .max(PRODUCT_IMAGE_LIMIT, `最多上传 ${PRODUCT_IMAGE_LIMIT} 张图片`);

export const productFormSchema = z.object({
  title: z.string().trim().min(4, "标题至少 4 个字").max(60, "标题不能超过 60 个字"),
  description: z
    .string()
    .trim()
    .min(10, "描述至少 10 个字")
    .max(1000, "描述不能超过 1000 个字"),
  price: priceSchema,
  originalPrice: optionalPriceSchema,
  categoryId: z.string().trim().min(1, "请选择商品分类"),
  condition: z.enum(["NEW", "LIKE_NEW", "LIGHTLY_USED", "NORMAL_USED", "HEAVILY_USED"]),
  locationText: z
    .string()
    .trim()
    .min(2, "交易地点至少 2 个字")
    .max(50, "交易地点不能超过 50 个字"),
  imageUrls: imageUrlsSchema,
});

export const productStatusSchema = z.object({
  productId: z.string().trim().min(1),
  status: z.enum(["ACTIVE", "RESERVED", "SOLD", "OFFLINE"]),
});

export type ProductFormInput = z.infer<typeof productFormSchema>;
