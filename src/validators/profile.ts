import { z } from "zod";
import { isManageableImageValue } from "@/lib/asset-ref";

const optionalImage = z
  .string()
  .trim()
  .optional()
  .transform((value) => value ?? "")
  .refine((value) => value === "" || isManageableImageValue(value), {
    message: "请填写合法的图片地址",
  });

const requiredImage = z
  .string()
  .trim()
  .min(1, "请上传学生证图片或填写图片地址")
  .refine((value) => isManageableImageValue(value), {
    message: "请填写合法的学生证图片地址",
  });

export const profileFormSchema = z.object({
  name: z.string().trim().min(2, "昵称至少 2 个字").max(20, "昵称不能超过 20 个字"),
  bio: z
    .string()
    .trim()
    .max(160, "个人简介不能超过 160 个字")
    .optional()
    .transform((value) => value ?? ""),
  college: z
    .string()
    .trim()
    .max(40, "学院名称不能超过 40 个字")
    .optional()
    .transform((value) => value ?? ""),
  grade: z
    .string()
    .trim()
    .max(20, "年级不能超过 20 个字")
    .optional()
    .transform((value) => value ?? ""),
  phone: z
    .string()
    .trim()
    .max(20, "手机号不能超过 20 个字符")
    .optional()
    .transform((value) => value ?? ""),
  avatarUrl: optionalImage,
});

export const verificationFormSchema = z.object({
  schoolName: z.string().trim().min(2, "学校名称至少 2 个字").max(40, "学校名称不能超过 40 个字"),
  campusName: z.string().trim().min(2, "校区名称至少 2 个字").max(40, "校区名称不能超过 40 个字"),
  studentIdLast4: z.string().trim().regex(/^\d{4}$/, "学号后四位必须是 4 位数字"),
  studentCardImage: requiredImage,
});
