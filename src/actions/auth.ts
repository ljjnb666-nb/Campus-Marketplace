"use server";

import { hash } from "bcryptjs";
import { Prisma } from "@prisma/client";
import { registerSchema } from "@/validators/auth";
import { prisma } from "@/lib/prisma";

export type ActionState = {
  success: boolean;
  message: string;
};

export async function registerUser(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = registerSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
    schoolName: formData.get("schoolName"),
    campusId: formData.get("campusId"),
  });

  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "提交数据无效",
    };
  }

  const campus = await prisma.campus.findUnique({
    where: { id: parsed.data.campusId },
  });

  if (!campus) {
    return { success: false, message: "校区不存在" };
  }

  try {
    await prisma.user.create({
      data: {
        name: parsed.data.name,
        email: parsed.data.email,
        passwordHash: await hash(parsed.data.password, 10),
        schoolName: parsed.data.schoolName,
        campusId: parsed.data.campusId,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { success: false, message: "该邮箱已注册" };
    }

    return { success: false, message: "注册失败，请稍后重试" };
  }

  return { success: true, message: "注册成功，请登录" };
}
