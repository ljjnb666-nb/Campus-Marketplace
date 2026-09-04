"use server";

import { headers } from "next/headers";
import { hash } from "bcryptjs";
import { Prisma } from "@prisma/client";
import { registerSchema } from "@/validators/auth";
import { isRateLimited } from "@/lib/rate-limit";
import { prisma, withTransaction } from "@/lib/prisma";
import {
  isGovernanceError,
} from "@/lib/governance/domain-errors";
import { recordSignupAcceptances } from "@/lib/legal/policy-service";

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

function parseAcceptedDocumentIds(formData: FormData): string[] {
  return formData
    .getAll("acceptedDocumentIds")
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);
}

export async function registerUser(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { limited } = await isRateLimited({
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
    acceptedDocumentIds: parseAcceptedDocumentIds(formData),
    agreeLegal: formData.get("agreeLegal") ?? "",
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
    // 用户创建与同意证据同事务：不存在"已注册但无同意记录"的中间态，
    // 也不存在"同意记录指向非当前版本"的中间态（recordSignupAcceptances
    // 内部 fail-closed 校验当前 required 集合）。
    await withTransaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: parsed.data.name,
          email: parsed.data.email,
          passwordHash: await hash(parsed.data.password, 10),
          schoolName: parsed.data.schoolName,
          campusId: parsed.data.campusId,
        },
      });

      await recordSignupAcceptances(tx, user.id, parsed.data.acceptedDocumentIds);
    });
  } catch (error) {
    if (isGovernanceError(error)) {
      return { success: false, message: error.message };
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { success: false, message: "该邮箱已注册" };
    }

    return { success: false, message: "注册失败，请稍后重试" };
  }

  return { success: true, message: "注册成功，请登录" };
}
