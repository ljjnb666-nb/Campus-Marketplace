import { z } from "zod";
import { isManageableImageValue, isControlledVerificationEvidence } from "@/lib/asset-ref";

const optionalImage = z
  .string()
  .trim()
  .optional()
  .transform((value) => value ?? "")
  .refine((value) => value === "" || isManageableImageValue(value), {
    message: "请填写合法的图片地址",
  });

// RB-01 Repair 2：认证证据只接受受控 asset:<id> 引用（上传体系产生）；
// 历史 /uploads/ 直链与外链不再是合法的新提交形态，防止绕过私有资产模型
const requiredControlledEvidence = z
  .string()
  .trim()
  .min(1, "请上传学生证图片")
  .refine((value) => isControlledVerificationEvidence(value), {
    message: "学生证材料必须通过平台上传后提交",
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
  studentCardImage: requiredControlledEvidence,
});
