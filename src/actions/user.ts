"use server";

import { revalidatePath } from "next/cache";
import { actionErrorMessage } from "@/lib/error-handler";
import { withTransaction } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";
import { submitMembershipVerification } from "@/lib/campus/verification-service";
import { updateOwnProfileTx } from "@/lib/user/profile-service";
import {
  buildAssetReference,
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
    // entry auth = 身份发现；active-account 序列化在事务内
    // prepareActiveAccountMutation 完成（RB-03，与 erasure 同锁域）
    const user = await requireUser();
    // 头像上传是外部副作用（S3 PUT），保持在事务外；mutation 被生命周期
    // 守卫拒绝时上传资产停留 UPLOADED，由既有 stale-upload cleanup 兜底
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

    const result = await withTransaction((tx) =>
      updateOwnProfileTx(tx, user.id, {
        name: parsed.data.name,
        bio: parsed.data.bio,
        college: parsed.data.college,
        grade: parsed.data.grade,
        phone: parsed.data.phone,
        avatarToken: parsed.data.avatarUrl,
      }),
    );

    // Repair 4：旧头像的 PENDING_DELETE 标记已随 updateOwnProfileTx 同事务
    // 完成——不再做事务外 best-effort 标记（.catch(() => undefined) 吞错
    // = 对象永久泄漏，已结构性移除）。

    revalidateUserPages();

    const { previousAvatarUrl: _ignored, replacedAssetsMarkedForDeletion: _ignoredCount, ...updatedUser } = result;

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

    // Phase 6A：提交走中央认证状态机（subject 锁 → 账号/membership/policy
    // 复核 → 状态机断言 → 证据落库），policy 版本快照随证据保留。
    // Repair 4：被替换旧认证材料的 PENDING_DELETE 标记已随
    // submitMembershipVerification 的 canonical lifecycle 事务完成——
    // 不再做事务外 pre-read + post-commit best-effort 标记。
    await submitMembershipVerification({
      userId: user.id,
      schoolName: parsed.data.schoolName,
      campusName: parsed.data.campusName,
      studentIdLast4: parsed.data.studentIdLast4,
      studentCardImageToken: parsed.data.studentCardImage,
    });

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
