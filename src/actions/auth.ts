"use server";

import { headers } from "next/headers";
import { hash } from "bcryptjs";
import { Prisma } from "@prisma/client";
import { registerSchema } from "@/validators/auth";
import { isRateLimited } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";

export type ActionState = {
  success: boolean;
  message: string;
};

const REGISTER_RATE_LIMIT = 5;
const REGISTER_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

async function resolveClientIp(): Promise<string> {
  const forwardedFor = (await headers()).get("x-forwarded-for");
  return forwardedFor?.split(",")[0]?.trim() || "unknown";
}

export async function registerUser(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { limited } = isRateLimited({
    key: `register:${await resolveClientIp()}`,
    limit: REGISTER_RATE_LIMIT,
    windowMs: REGISTER_RATE_LIMIT_WINDOW_MS,
  });

  if (limited) {
    return { success: false, message: "注册操作过于频繁，请稍后再试" };
  }

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
