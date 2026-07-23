"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { containsBannedKeyword } from "@/lib/moderation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";
import { saveUploadedImage } from "@/lib/upload";
import { serviceFormSchema, serviceStatusSchema } from "@/validators/service";

export type ServiceActionState = {
  success: boolean;
  message: string;
  redirectTo?: string;
};

const initialState: ServiceActionState = {
  success: false,
  message: "",
};

function decimalValue(value: string) {
  return new Prisma.Decimal(value);
}

function applyServiceRevalidation(serviceId?: string) {
  revalidatePath("/");
  revalidatePath("/services");
  revalidatePath("/my/services");

  if (serviceId) {
    revalidatePath(`/services/${serviceId}`);
    revalidatePath(`/services/${serviceId}/edit`);
  }
}

async function ensureActiveServiceCategory(categoryId: string) {
  return prisma.serviceCategory.findFirst({
    where: {
      id: categoryId,
      isActive: true,
    },
    select: {
      id: true,
    },
  });
}

async function resolveCoverImage(formData: FormData) {
  const file = formData.get("coverImageFile");

  if (file instanceof File && file.size > 0) {
    return saveUploadedImage(file, "service");
  }

  return String(formData.get("coverImageUrl") ?? "").trim();
}

export async function createService(
  _prevState: ServiceActionState,
  formData: FormData,
): Promise<ServiceActionState> {
  const user = await requireUser();
  const coverImageUrl = await resolveCoverImage(formData);

  const parsed = serviceFormSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description"),
    categoryId: formData.get("categoryId"),
    price: formData.get("price"),
    pricingUnit: formData.get("pricingUnit"),
    locationText: formData.get("locationText"),
    availableSchedule: formData.get("availableSchedule"),
    coverImageUrl,
  });

  if (!parsed.success) {
    return {
      ...initialState,
      message: parsed.error.issues[0]?.message ?? "服务信息不完整",
    };
  }

  const bannedKeyword = await containsBannedKeyword(
    `${parsed.data.title}\n${parsed.data.description}\n${parsed.data.availableSchedule}`,
  );

  if (bannedKeyword) {
    return {
      ...initialState,
      message: `内容命中违规关键词：${bannedKeyword}`,
    };
  }

  const [provider, category] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: { campusId: true },
    }),
    ensureActiveServiceCategory(parsed.data.categoryId),
  ]);

  if (!provider) {
    return { ...initialState, message: "用户不存在" };
  }

  if (!category) {
    return { ...initialState, message: "服务分类不存在或已停用" };
  }

  const service = await prisma.serviceListing.create({
    data: {
      title: parsed.data.title,
      description: parsed.data.description,
      categoryId: parsed.data.categoryId,
      price: decimalValue(parsed.data.price),
      pricingUnit: parsed.data.pricingUnit,
      locationText: parsed.data.locationText,
      availableSchedule: parsed.data.availableSchedule || null,
      coverImageUrl: parsed.data.coverImageUrl || null,
      campusId: provider.campusId,
      providerId: user.id,
    },
  });

  applyServiceRevalidation(service.id);

  return {
    success: true,
    message: "服务已发布",
    redirectTo: `/services/${service.id}`,
  };
}

export async function updateService(
  _prevState: ServiceActionState,
  formData: FormData,
): Promise<ServiceActionState> {
  const user = await requireUser();
  const serviceId = String(formData.get("serviceId") ?? "");
  const coverImageUrl = await resolveCoverImage(formData);

  const parsed = serviceFormSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description"),
    categoryId: formData.get("categoryId"),
    price: formData.get("price"),
    pricingUnit: formData.get("pricingUnit"),
    locationText: formData.get("locationText"),
    availableSchedule: formData.get("availableSchedule"),
    coverImageUrl,
  });

  if (!serviceId) {
    return { ...initialState, message: "服务不存在" };
  }

  if (!parsed.success) {
    return {
      ...initialState,
      message: parsed.error.issues[0]?.message ?? "服务信息不完整",
    };
  }

  const bannedKeyword = await containsBannedKeyword(
    `${parsed.data.title}\n${parsed.data.description}\n${parsed.data.availableSchedule}`,
  );

  if (bannedKeyword) {
    return {
      ...initialState,
      message: `内容命中违规关键词：${bannedKeyword}`,
    };
  }

  const [service, category] = await Promise.all([
    prisma.serviceListing.findFirst({
      where: {
        id: serviceId,
        providerId: user.id,
        deletedAt: null,
      },
      select: { id: true },
    }),
    ensureActiveServiceCategory(parsed.data.categoryId),
  ]);

  if (!service) {
    return { ...initialState, message: "无权修改该服务" };
  }

  if (!category) {
    return { ...initialState, message: "服务分类不存在或已停用" };
  }

  await prisma.serviceListing.update({
    where: { id: serviceId },
    data: {
      title: parsed.data.title,
      description: parsed.data.description,
      categoryId: parsed.data.categoryId,
      price: decimalValue(parsed.data.price),
      pricingUnit: parsed.data.pricingUnit,
      locationText: parsed.data.locationText,
      availableSchedule: parsed.data.availableSchedule || null,
      coverImageUrl: parsed.data.coverImageUrl || null,
    },
  });

  applyServiceRevalidation(serviceId);

  return {
    success: true,
    message: "服务已更新",
    redirectTo: `/services/${serviceId}`,
  };
}

export async function updateServiceStatus(formData: FormData) {
  const user = await requireUser();

  const parsed = serviceStatusSchema.safeParse({
    serviceId: formData.get("serviceId"),
    status: formData.get("status"),
  });

  if (!parsed.success) {
    return;
  }

  const service = await prisma.serviceListing.findFirst({
    where: {
      id: parsed.data.serviceId,
      providerId: user.id,
      deletedAt: null,
    },
    select: { id: true },
  });

  if (!service) {
    return;
  }

  await prisma.serviceListing.update({
    where: { id: parsed.data.serviceId },
    data: { status: parsed.data.status },
  });

  applyServiceRevalidation(parsed.data.serviceId);
}

export async function deleteService(formData: FormData) {
  const user = await requireUser();
  const serviceId = String(formData.get("serviceId") ?? "");

  if (!serviceId) {
    redirect("/my/services");
  }

  const service = await prisma.serviceListing.findFirst({
    where: {
      id: serviceId,
      providerId: user.id,
      deletedAt: null,
    },
    select: { id: true },
  });

  if (!service) {
    redirect("/my/services");
  }

  await prisma.serviceListing.update({
    where: { id: serviceId },
    data: {
      status: "OFFLINE",
      deletedAt: new Date(),
    },
  });

  applyServiceRevalidation(serviceId);
  redirect("/my/services");
}
