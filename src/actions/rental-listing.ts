"use server";

import { RentalListingStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { decimalValue } from "@/lib/decimal";
import { actionErrorMessage } from "@/lib/error-handler";
import { containsBannedKeyword } from "@/lib/moderation";
import { prisma, withTransaction } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";
import {
  buildAssetReference,
  markAssetsForValuesPendingDelete,
  resolveImageTokens,
  uploadImageAsset,
} from "@/lib/upload";
import { rentalListingFormSchema } from "@/validators/rental";

export type RentalListingActionState = {
  success: boolean;
  message: string;
  redirectTo?: string;
};
const initialState: RentalListingActionState = { success: false, message: "" };

async function extractImageTokens(formData: FormData, ownerId: string) {
  const imageUrls = formData.getAll("imageUrls").map((value) => String(value).trim());
  const imageFiles = formData.getAll("imageFiles");

  const values = await Promise.all(
    Array.from({ length: Math.max(imageUrls.length, imageFiles.length) }, async (_, index) => {
      const file = imageFiles[index];

      if (file instanceof File && file.size > 0) {
        const result = await uploadImageAsset({ userId: ownerId, category: "rental", file });
        return buildAssetReference(result.assetId);
      }

      return imageUrls[index] || null;
    }),
  );

  return values.filter((value): value is string => Boolean(value));
}

export async function createRentalListing(
  _prevState: RentalListingActionState | null,
  formData: FormData,
): Promise<RentalListingActionState> {
  try {
    const user = await requireUser();
    const imageTokens = await extractImageTokens(formData, user.id);

    const parsed = rentalListingFormSchema.safeParse({
      title: formData.get("title"),
      description: formData.get("description"),
      categoryId: formData.get("categoryId"),
      condition: formData.get("condition"),
      brand: formData.get("brand"),
      model: formData.get("model"),
      referenceValue: formData.get("referenceValue"),
      price: formData.get("price"),
      pricingUnit: formData.get("pricingUnit"),
      depositAmount: formData.get("depositAmount"),
      minimumDuration: formData.get("minimumDuration"),
      maximumDuration: formData.get("maximumDuration"),
      totalQuantity: formData.get("totalQuantity"),
      pickupLocation: formData.get("pickupLocation"),
      returnLocation: formData.get("returnLocation"),
      usageRules: formData.get("usageRules"),
      damagePolicy: formData.get("damagePolicy"),
      overduePolicy: formData.get("overduePolicy"),
      requiresApproval: formData.get("requiresApproval"),
      imageUrls: imageTokens,
    });

    if (!parsed.success) {
      return { ...initialState, message: parsed.error.issues[0]?.message ?? "表单数据有误" };
    }

    const { data } = parsed;

    if (Number(data.minimumDuration) > Number(data.maximumDuration)) {
      return { ...initialState, message: "最短租期不能大于最长租期" };
    }

    const bannedKeyword = await containsBannedKeyword(
      `${data.title}\n${data.description}\n${data.usageRules || ""}\n${data.damagePolicy || ""}\n${data.overduePolicy || ""}`
    );

    if (bannedKeyword) {
      return { ...initialState, message: `内容命中违规关键词：${bannedKeyword}` };
    }

    const category = await prisma.rentalCategory.findUnique({
      where: { id: data.categoryId },
      select: { id: true, isActive: true },
    });

    if (!category || !category.isActive) {
      return { ...initialState, message: "物品分类不存在或已停用" };
    }

    const owner = await prisma.user.findUnique({
      where: { id: user.id },
      select: { campusId: true },
    });

    if (!owner) return { ...initialState, message: "用户不存在" };

    // 事务内完成：listing 落库 → 图片 token 解析（attach 新上传资源）→ 图片行落库
    const listing = await withTransaction(async (tx) => {
      const created = await tx.rentalListing.create({
        data: {
          title: data.title,
          description: data.description,
          categoryId: data.categoryId,
          campusId: owner.campusId,
          ownerId: user.id,
          condition: data.condition,
          brand: data.brand || null,
          model: data.model || null,
          referenceValue: data.referenceValue ? decimalValue(data.referenceValue) : null,
          price: decimalValue(data.price),
          pricingUnit: data.pricingUnit,
          depositAmount: decimalValue(data.depositAmount),
          minimumDuration: Number(data.minimumDuration),
          maximumDuration: Number(data.maximumDuration),
          totalQuantity: Number(data.totalQuantity),
          availableQuantity: Number(data.totalQuantity),
          pickupLocation: data.pickupLocation,
          returnLocation: data.returnLocation,
          usageRules: data.usageRules || null,
          damagePolicy: data.damagePolicy || null,
          overduePolicy: data.overduePolicy || null,
          requiresApproval: data.requiresApproval || false,
        },
      });

      const imageUrls = await resolveImageTokens({
        ownerId: user.id,
        tokens: data.imageUrls,
        target: { type: "rentalListing", id: created.id },
        tx,
      });

      if (imageUrls.length > 0) {
        await tx.rentalListingImage.createMany({
          data: imageUrls.map((url, index) => ({
            rentalListingId: created.id,
            url,
            sortOrder: index,
          })),
        });
      }

      return created;
    });

    revalidatePath('/rentals');
    revalidatePath('/my/rental-listings');
    revalidatePath('/');

    return { success: true, message: '出租物品发布成功', redirectTo: `/rentals/${listing.id}` };
  } catch (error) {
    return { ...initialState, message: actionErrorMessage(error, "createRentalListing") };
  }
}

export async function updateRentalListing(
  _prevState: RentalListingActionState | null,
  formData: FormData,
): Promise<RentalListingActionState> {
  try {
    const user = await requireUser();
    const listingId = String(formData.get("listingId") ?? "");
    const imageTokens = await extractImageTokens(formData, user.id);

    const parsed = rentalListingFormSchema.safeParse({
      title: formData.get("title"),
      description: formData.get("description"),
      categoryId: formData.get("categoryId"),
      condition: formData.get("condition"),
      brand: formData.get("brand"),
      model: formData.get("model"),
      referenceValue: formData.get("referenceValue"),
      price: formData.get("price"),
      pricingUnit: formData.get("pricingUnit"),
      depositAmount: formData.get("depositAmount"),
      minimumDuration: formData.get("minimumDuration"),
      maximumDuration: formData.get("maximumDuration"),
      totalQuantity: formData.get("totalQuantity"),
      pickupLocation: formData.get("pickupLocation"),
      returnLocation: formData.get("returnLocation"),
      usageRules: formData.get("usageRules"),
      damagePolicy: formData.get("damagePolicy"),
      overduePolicy: formData.get("overduePolicy"),
      requiresApproval: formData.get("requiresApproval"),
      imageUrls: imageTokens,
    });

    if (!listingId) return { ...initialState, message: "物品不存在" };
    if (!parsed.success) return { ...initialState, message: parsed.error.issues[0]?.message ?? "表单数据有误" };

    const { data } = parsed;

    if (Number(data.minimumDuration) > Number(data.maximumDuration)) {
      return { ...initialState, message: "最短租期不能大于最长租期" };
    }

    const bannedKeyword = await containsBannedKeyword(
      `${data.title}\n${data.description}\n${data.usageRules || ""}\n${data.damagePolicy || ""}\n${data.overduePolicy || ""}`
    );

    if (bannedKeyword) {
      return { ...initialState, message: `内容命中违规关键词：${bannedKeyword}` };
    }

    const [existingListing, category, previousImages] = await Promise.all([
      prisma.rentalListing.findFirst({
        where: { id: listingId, ownerId: user.id, deletedAt: null },
        select: { id: true, status: true },
      }),
      prisma.rentalCategory.findUnique({
        where: { id: data.categoryId },
        select: { id: true, isActive: true },
      }),
      prisma.rentalListingImage.findMany({
        where: { rentalListingId: listingId },
        select: { url: true },
      }),
    ]);

    if (!existingListing) return { ...initialState, message: "无权修改该物品" };
    if (!category || !category.isActive) return { ...initialState, message: "分类不存在或已停用" };

    const imageUrls = await withTransaction(async (tx) => {
      await tx.rentalListing.update({
        where: { id: listingId },
        data: {
          title: data.title,
          description: data.description,
          categoryId: data.categoryId,
          condition: data.condition,
          brand: data.brand || null,
          model: data.model || null,
          referenceValue: data.referenceValue ? decimalValue(data.referenceValue) : null,
          price: decimalValue(data.price),
          pricingUnit: data.pricingUnit,
          depositAmount: decimalValue(data.depositAmount),
          minimumDuration: Number(data.minimumDuration),
          maximumDuration: Number(data.maximumDuration),
          totalQuantity: Number(data.totalQuantity),
          pickupLocation: data.pickupLocation,
          returnLocation: data.returnLocation,
          usageRules: data.usageRules || null,
          damagePolicy: data.damagePolicy || null,
          overduePolicy: data.overduePolicy || null,
          requiresApproval: data.requiresApproval || false,
        },
      });
      await tx.rentalListingImage.deleteMany({ where: { rentalListingId: listingId } });

      const urls = await resolveImageTokens({
        ownerId: user.id,
        tokens: data.imageUrls,
        target: { type: "rentalListing", id: listingId },
        tx,
      });

      if (urls.length > 0) {
        await tx.rentalListingImage.createMany({
          data: urls.map((url, index) => ({
            rentalListingId: listingId,
            url,
            sortOrder: index,
          })),
        });
      }
      return urls;
    });

    // 被移除的旧图标记待删除（异步由 cleanup 物理清理）
    const removed = previousImages.map((image) => image.url).filter((url) => !imageUrls.includes(url));
    if (removed.length > 0) {
      await markAssetsForValuesPendingDelete(user.id, removed).catch(() => undefined);
    }

    revalidatePath('/rentals');
    revalidatePath(`/rentals/${listingId}`);
    revalidatePath('/my/rental-listings');

    return { success: true, message: '物品已更新', redirectTo: `/rentals/${listingId}` };
  } catch (error) {
    return { ...initialState, message: actionErrorMessage(error, "updateRentalListing") };
  }
}

export async function updateRentalListingStatus(formData: FormData) {
  try {
    const user = await requireUser();
    const listingId = String(formData.get("listingId") ?? "");
    const status = String(formData.get("status") ?? "");

    if (!["AVAILABLE", "PAUSED", "OFFLINE"].includes(status)) return;

    const listing = await prisma.rentalListing.findFirst({
      where: { id: listingId, ownerId: user.id, deletedAt: null },
      select: { id: true, status: true },
    });

    if (!listing) return;
    if (listing.status === "BANNED" || listing.status === "PENDING_REVIEW") return;

    await prisma.rentalListing.update({
      where: { id: listingId },
      data: { status: status as RentalListingStatus },
    });

    revalidatePath('/rentals');
    revalidatePath(`/rentals/${listingId}`);
    revalidatePath('/my/rental-listings');
  } catch (error) {
    actionErrorMessage(error, "updateRentalListingStatus");
  }
}

export async function deleteRentalListing(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") ?? "");

  const listing = await prisma.rentalListing.findFirst({
    where: { id: listingId, ownerId: user.id, deletedAt: null },
    select: { id: true },
  });

  if (!listing) redirect('/my/rental-listings');

  const activeOrders = await prisma.rentalOrder.count({
    where: {
      rentalListingId: listingId,
      status: { notIn: ['COMPLETED', 'CANCELLED', 'REJECTED', 'CLOSED'] },
    },
  });

  if (activeOrders > 0) return;

  try {
    await prisma.rentalListing.update({
      where: { id: listingId },
      data: { deletedAt: new Date(), status: 'OFFLINE' },
    });

    // 软删除时标记图片资源待删除（对象由 cleanup 异步物理清理）
    const images = await prisma.rentalListingImage.findMany({
      where: { rentalListingId: listingId },
      select: { url: true },
    });
    if (images.length > 0) {
      await markAssetsForValuesPendingDelete(
        user.id,
        images.map((image) => image.url),
      ).catch(() => undefined);
    }

    revalidatePath('/rentals');
    revalidatePath('/my/rental-listings');
  } catch (error) {
    actionErrorMessage(error, "deleteRentalListing");
  }

  redirect('/my/rental-listings');
}
