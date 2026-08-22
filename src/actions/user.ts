"use server";

import { revalidatePath } from "next/cache";
import { actionErrorMessage } from "@/lib/error-handler";
import { prisma, withTransaction } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";
import { saveUploadedImage, type UploadCategory } from "@/lib/upload";
import { createNotification } from "@/repositories/notification-repository";
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

async function resolveSingleImage(
  formData: FormData,
  urlField: string,
  fileField: string,
  folder: UploadCategory,
) {
  const file = formData.get(fileField);

  if (file instanceof File && file.size > 0) {
    return saveUploadedImage(file, folder);
  }

  return String(formData.get(urlField) ?? "").trim();
}

export async function updateProfile(
  _prevState: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  try {
    const user = await requireUser();
    const avatarUrl = await resolveSingleImage(formData, "avatarUrl", "avatarFile", "avatar");

    const parsed = profileFormSchema.safeParse({
      name: formData.get("name"),
      bio: formData.get("bio"),
      college: formData.get("college"),
      grade: formData.get("grade"),
      phone: formData.get("phone"),
      avatarUrl,
    });

    if (!parsed.success) {
      return {
        ...initialState,
        message: parsed.error.issues[0]?.message ?? "资料信息不完整",
      };
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        name: parsed.data.name,
        bio: parsed.data.bio || null,
        college: parsed.data.college || null,
        grade: parsed.data.grade || null,
        phone: parsed.data.phone || null,
        avatarUrl: parsed.data.avatarUrl || null,
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
    const studentCardImage = await resolveSingleImage(
      formData,
      "studentCardImage",
      "studentCardImageFile",
      "verification",
    );

    const parsed = verificationFormSchema.safeParse({
      schoolName: formData.get("schoolName"),
      campusName: formData.get("campusName"),
      studentIdLast4: formData.get("studentIdLast4"),
      studentCardImage,
    });

    if (!parsed.success) {
      return {
        ...initialState,
        message: parsed.error.issues[0]?.message ?? "认证信息不完整",
      };
    }

    await withTransaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          schoolName: parsed.data.schoolName,
          studentIdLast4: parsed.data.studentIdLast4,
          verificationStatus: "PENDING",
        },
      });

      await tx.userVerification.upsert({
        where: { userId: user.id },
        update: {
          schoolName: parsed.data.schoolName,
          campusName: parsed.data.campusName,
          studentIdLast4: parsed.data.studentIdLast4,
          studentCardImage: parsed.data.studentCardImage,
          status: "PENDING",
          reviewNote: null,
          reviewedAt: null,
          submittedAt: new Date(),
        },
        create: {
          userId: user.id,
          schoolName: parsed.data.schoolName,
          campusName: parsed.data.campusName,
          studentIdLast4: parsed.data.studentIdLast4,
          studentCardImage: parsed.data.studentCardImage,
          status: "PENDING",
        },
      });

      await createNotification(tx, {
        userId: user.id,
        type: "SYSTEM",
        title: "认证材料已提交",
        content: "你的校园认证材料已提交，平台会尽快完成审核，请留意后续通知。",
      });
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
