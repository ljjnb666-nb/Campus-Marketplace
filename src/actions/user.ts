"use server";

import { revalidatePath } from "next/cache";
import { actionErrorMessage } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";
import { submitMembershipVerification } from "@/lib/campus/verification-service";
import {
  buildAssetReference,
  markAssetsForValuesPendingDelete,
  resolveSingleImageToken,
  uploadImageAsset,
} from "@/lib/upload";
import { profileFormSchema, verificationFormSchema } from "@/validators/profile";

export type UserActionState = {
  success: boolean;
  message: string;
  redirectTo?: string;
  data?: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    bio: string | null;
    college: string | null;
    grade: string | null;
    phone: string | null;
  };
};

const initialState: UserActionState = {
  success: false,
  message: "",
};

function revalidateUserPages() {
  revalidatePath("/profile");
  revalidatePath("/verification");
  revalidatePath("/notifications");
  revalidatePath("/", "layout");
}

/**
 * 单图字段 token 化：File 直传 → asset: 引用；否则取既有 URL/引用值。
 */
async function buildSingleImageToken(
  formData: FormData,
  urlField: string,
  fileField: string,
  category: "avatar" | "verification",
  ownerId: string,
) {
  const file = formData.get(fileField);

  if (file instanceof File && file.size > 0) {
    const result = await uploadImageAsset({ userId: ownerId, category, file });
    return buildAssetReference(result.assetId);
  }

  return String(formData.get(urlField) ?? "").trim();
}

export async function updateProfile(
  _prevState: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  try {
    const user = await requireUser();
    const avatarToken = await buildSingleImageToken(
      formData,
      "avatarUrl",
      "avatarFile",
      "avatar",
      user.id,
    );

    const parsed = profileFormSchema.safeParse({
      name: formData.get("name"),
      bio: formData.get("bio"),
      college: formData.get("college"),
      grade: formData.get("grade"),
      phone: formData.get("phone"),
      avatarUrl: avatarToken,
    });

    if (!parsed.success) {
      return {
        ...initialState,
        message: parsed.error.issues[0]?.message ?? "资料信息不完整",
      };
    }

    const previousUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { avatarUrl: true },
    });

    // 头像 token 规范化并绑定新上传资源（avatar 无独立实体，仅标记 ATTACHED）
    const avatarUrl = await resolveSingleImageToken({
      ownerId: user.id,
      token: parsed.data.avatarUrl,
      target: { type: "avatar" },
    });

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        name: parsed.data.name,
        bio: parsed.data.bio || null,
        college: parsed.data.college || null,
        grade: parsed.data.grade || null,
        phone: parsed.data.phone || null,
        avatarUrl: avatarUrl || null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        avatarUrl: true,
        bio: true,
        college: true,
        grade: true,
        phone: true,
      },
    });

    // 头像被替换时标记旧资源待删除
    const previousAvatar = previousUser?.avatarUrl;
    if (previousAvatar && previousAvatar !== avatarUrl) {
      await markAssetsForValuesPendingDelete(user.id, [previousAvatar]).catch(() => undefined);
    }

    revalidateUserPages();

    return {
      success: true,
      message: "个人资料已更新",
      redirectTo: "/profile",
      data: updatedUser,
    };
  } catch (error) {
    return { ...initialState, message: actionErrorMessage(error, "updateProfile") };
  }
}

export async function submitVerification(
  _prevState: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  try {
    const user = await requireUser();
    const studentCardToken = await buildSingleImageToken(
      formData,
      "studentCardImage",
      "studentCardImageFile",
      "verification",
      user.id,
    );

    const parsed = verificationFormSchema.safeParse({
      schoolName: formData.get("schoolName"),
      campusName: formData.get("campusName"),
      studentIdLast4: formData.get("studentIdLast4"),
      studentCardImage: studentCardToken,
    });

    if (!parsed.success) {
      return {
        ...initialState,
        message: parsed.error.issues[0]?.message ?? "认证信息不完整",
      };
    }

    const previousVerification = await prisma.userVerification.findUnique({
      where: { userId: user.id },
      select: { studentCardImage: true },
    });

    // Phase 6A：提交走中央认证状态机（subject 锁 → 账号/membership/policy
    // 复核 → 状态机断言 → 证据落库），policy 版本快照随证据保留
    await submitMembershipVerification({
      userId: user.id,
      schoolName: parsed.data.schoolName,
      campusName: parsed.data.campusName,
      studentIdLast4: parsed.data.studentIdLast4,
      studentCardImageToken: parsed.data.studentCardImage,
    });

    // 重新提交时旧的学生证材料标记待删除（原 PENDING 审核材料被替换）
    if (previousVerification?.studentCardImage && previousVerification.studentCardImage !== studentCardToken) {
      await markAssetsForValuesPendingDelete(user.id, [
        previousVerification.studentCardImage,
      ]).catch(() => undefined);
    }

    revalidateUserPages();

    return {
      success: true,
      message: "认证材料已提交，等待审核",
      redirectTo: "/verification",
    };
  } catch (error) {
    return { ...initialState, message: actionErrorMessage(error, "submitVerification") };
  }
}
