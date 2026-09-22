"use server";

import { headers } from "next/headers";
import { hash } from "bcryptjs";
import { Prisma } from "@prisma/client";
import { registerSchema } from "@/validators/auth";
import { isRateLimited } from "@/lib/rate-limit";
import { isGovernanceError } from "@/lib/governance/domain-errors";
import { registerActiveCampusUser } from "@/lib/registration-service";

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

  // Final Review Repair 1（FR01 hash discipline）：bcrypt 哈希在事务与
  // CAMPUS 锁窗口之外计算——锁持有时间最小化。
  const passwordHash = await hash(parsed.data.password, 10);

  try {
    // Phase 7H Final Review Repair 1（FR01 TOCTOU 关闭）：isActive admission
    // 判定移入注册事务内的 CAMPUS:<campusId> governance 锁之后（locked
    // re-read），与 deactivateGovernanceCampus 共享同一 serialization
    // boundary——只有"注册先提交"或"停用先提交"两种线性化终态，绝无
    // "停用先提交且注册后提交"的交错。注册页 selector 只展示启用校区
    // （listActiveCampuses 呈现层过滤），服务端 admission gate 同语义。
    // 用户创建 / ACTIVE CampusMembership / legal acceptances 同事务原子
    // 提交（零部分注册）。
    const result = await registerActiveCampusUser({
      name: parsed.data.name,
      email: parsed.data.email,
      passwordHash,
      schoolName: parsed.data.schoolName,
      campusId: parsed.data.campusId,
      acceptedDocumentIds: parsed.data.acceptedDocumentIds,
    });

    if (!result.ok) {
      // 校区不存在与已停用同形拒绝（无存在性 oracle）
      return { success: false, message: "校区不存在" };
    }
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
