import { z } from "zod";

export const registerSchema = z
  .object({
    name: z.string().min(2, "昵称至少 2 个字符").max(20, "昵称不能超过 20 个字符"),
    email: z.string().email("请输入正确邮箱"),
    password: z
      .string()
      .min(8, "密码至少 8 位")
      .max(64, "密码不能超过 64 位")
      .regex(/[a-z]/, "密码需包含小写字母")
      .regex(/[A-Z]/, "密码需包含大写字母")
      .regex(/[0-9]/, "密码需包含数字"),
    confirmPassword: z.string().min(8, "确认密码至少 8 位"),
    schoolName: z.string().min(2, "学校名称必填"),
    campusId: z.string().min(1, "请选择校区"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "两次输入的密码不一致",
    path: ["confirmPassword"],
  });

export const loginSchema = z.object({
  email: z.string().email("请输入正确邮箱"),
  password: z.string().min(8, "密码至少 8 位"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
