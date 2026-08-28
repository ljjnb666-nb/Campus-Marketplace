"use server";

import { redirect } from "next/navigation";
import { decimalValue } from "@/lib/decimal";
import { actionErrorMessage } from "@/lib/error-handler";
import { containsBannedKeyword } from "@/lib/moderation";
import { prisma, withTransaction } from "@/lib/prisma";
import { revalidateProductViews } from "@/lib/revalidate";
import { requireUser } from "@/lib/server-auth";
import {
  markAssetsForValuesPendingDelete,
  resolveImageTokens,
  uploadImageAsset,
  buildAssetReference,
} from "@/lib/upload";
import { applyFavoriteToggle } from "@/lib/favorite-toggle";
import { productFormSchema, productStatusSchema } from "@/validators/product";

export type ProductActionState = {
  success: boolean;
  message: string;
  redirectTo?: string;
};

const initialState: ProductActionState = {
  success: false,
  message: "",
};

/**
 * 汇总表单图片 token：imageUrls 里的 asset:/URL 值 + 直传 File 上传后的引用。
 * 上传发生在表单整体校验之前（与既有行为一致），未完成发布的资源
 * 由 orphan cleanup（ASSET_ORPHAN_TTL_HOURS）回收。
 */
async function extractImageTokens(formData: FormData, ownerId: string) {
  const imageUrls = formData.getAll("imageUrls").map((value) => String(value).trim());
  const imageFiles = formData.getAll("imageFiles");

  const values = await Promise.all(
    Array.from({ length: Math.max(imageUrls.length, imageFiles.length) }, async (_, index) => {
      const file = imageFiles[index];

      if (file instanceof File && file.size > 0) {
        const result = await uploadImageAsset({ userId: ownerId, category: "product", file });
        return buildAssetReference(result.assetId);
      }

      return imageUrls[index] || null;
    }),
  );

  return values.filter((value): value is string => Boolean(value));
}

export async function createProduct(
  _prevState: ProductActionState | null,
  formData: FormData,
): Promise<ProductActionState> {
  try {
    const user = await requireUser();
    const imageTokens = await extractImageTokens(formData, user.id);

    const parsed = productFormSchema.safeParse({
      title: formData.get("title"),
      description: formData.get("description"),
      price: formData.get("price"),
      originalPrice: formData.get("originalPrice"),
      categoryId: formData.get("categoryId"),
      condition: formData.get("condition"),
      locationText: formData.get("locationText"),
      imageUrls: imageTokens,
    });

    if (!parsed.success) {
      return {
        ...initialState,
        message: parsed.error.issues[0]?.message ?? "商品信息不完整",
      };
    }

    const bannedKeyword = await containsBannedKeyword(
      `${parsed.data.title}\n${parsed.data.description}`,
    );

    if (bannedKeyword) {
      return {
        ...initialState,
        message: `内容命中违规关键词：${bannedKeyword}`,
      };
    }

    const seller = await prisma.user.findUnique({
      where: { id: user.id },
      select: { campusId: true },
    });

    if (!seller) {
      return { ...initialState, message: "用户不存在" };
    }

    const category = await prisma.productCategory.findUnique({
      where: { id: parsed.data.categoryId },
      select: { id: true, isActive: true },
    });

    if (!category || !category.isActive) {
      return { ...initialState, message: "商品分类不存在或已停用" };
    }

    // 事务内完成：商品落库 → 图片 token 解析（attach 新上传资源）→ 图片行落库。
    // token 中的 asset: 引用被规范化为公开 URL 后才写入 ProductImage。
    const product = await withTransaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          title: parsed.data.title,
          description: parsed.data.description,
          price: decimalValue(parsed.data.price),
          originalPrice: parsed.data.originalPrice
            ? decimalValue(parsed.data.originalPrice)
            : null,
          categoryId: parsed.data.categoryId,
          condition: parsed.data.condition,
          locationText: parsed.data.locationText,
          campusId: seller.campusId,
          sellerId: user.id,
        },
      });

      const imageUrls = await resolveImageTokens({
        ownerId: user.id,
        tokens: parsed.data.imageUrls,
        target: { type: "product", id: created.id },
        tx,
      });

      if (imageUrls.length > 0) {
        await tx.productImage.createMany({
          data: imageUrls.map((url, index) => ({
            productId: created.id,
            url,
            sortOrder: index,
          })),
        });
      }

      return created;
    });

    revalidateProductViews(product.id);

    return {
      success: true,
      message: "商品发布成功",
      redirectTo: `/products/${product.id}`,
    };
  } catch (error) {
    return { ...initialState, message: actionErrorMessage(error, "createProduct") };
  }
}

export async function updateProduct(
  _prevState: ProductActionState | null,
  formData: FormData,
): Promise<ProductActionState> {
  try {
    const user = await requireUser();
    const productId = String(formData.get("productId") ?? "");
    const imageTokens = await extractImageTokens(formData, user.id);

    const parsed = productFormSchema.safeParse({
      title: formData.get("title"),
      description: formData.get("description"),
      price: formData.get("price"),
      originalPrice: formData.get("originalPrice"),
      categoryId: formData.get("categoryId"),
      condition: formData.get("condition"),
      locationText: formData.get("locationText"),
      imageUrls: imageTokens,
    });

    if (!productId) {
      return { ...initialState, message: "商品不存在" };
    }

    if (!parsed.success) {
      return {
        ...initialState,
        message: parsed.error.issues[0]?.message ?? "商品信息不完整",
      };
    }

    const bannedKeyword = await containsBannedKeyword(
      `${parsed.data.title}\n${parsed.data.description}`,
    );

    if (bannedKeyword) {
      return {
        ...initialState,
        message: `内容命中违规关键词：${bannedKeyword}`,
      };
    }

    const [existingProduct, category, previousImages] = await Promise.all([
      prisma.product.findFirst({
        where: {
          id: productId,
          sellerId: user.id,
          deletedAt: null,
        },
        select: { id: true },
      }),
      prisma.productCategory.findUnique({
        where: { id: parsed.data.categoryId },
        select: { id: true, isActive: true },
      }),
      prisma.productImage.findMany({
        where: { productId },
        select: { url: true },
      }),
    ]);

    if (!existingProduct) {
      return { ...initialState, message: "无权修改该商品" };
    }

    if (!category || !category.isActive) {
      return { ...initialState, message: "商品分类不存在或已停用" };
    }

    const imageUrls = await withTransaction(async (tx) => {
      await tx.product.update({
        where: { id: productId },
        data: {
          title: parsed.data.title,
          description: parsed.data.description,
          price: decimalValue(parsed.data.price),
          originalPrice: parsed.data.originalPrice
            ? decimalValue(parsed.data.originalPrice)
            : null,
          categoryId: parsed.data.categoryId,
          condition: parsed.data.condition,
          locationText: parsed.data.locationText,
        },
      });
      await tx.productImage.deleteMany({
        where: { productId },
      });

      const urls = await resolveImageTokens({
        ownerId: user.id,
        tokens: parsed.data.imageUrls,
        target: { type: "product", id: productId },
        tx,
      });

      if (urls.length > 0) {
        await tx.productImage.createMany({
          data: urls.map((url, index) => ({
            productId,
            url,
            sortOrder: index,
          })),
        });
      }
      return urls;
    });

    // 被移除的旧图标记待删除（异步由 cleanup 物理清理，DB 与对象存储最终一致）
    const removed = previousImages.map((image) => image.url).filter((url) => !imageUrls.includes(url));
    if (removed.length > 0) {
      await markAssetsForValuesPendingDelete(user.id, removed).catch(() => undefined);
    }

    revalidateProductViews(productId);

    return {
      success: true,
      message: "商品已更新",
      redirectTo: `/products/${productId}`,
    };
  } catch (error) {
    return { ...initialState, message: actionErrorMessage(error, "updateProduct") };
  }
}

export async function updateProductStatus(formData: FormData) {
  try {
    const user = await requireUser();

    const parsed = productStatusSchema.safeParse({
      productId: formData.get("productId"),
      status: formData.get("status"),
    });

    if (!parsed.success) {
      return;
    }

    const product = await prisma.product.findFirst({
      where: {
        id: parsed.data.productId,
        sellerId: user.id,
        deletedAt: null,
      },
      select: { id: true },
    });

    if (!product) {
      return;
    }

    await prisma.product.update({
      where: { id: parsed.data.productId },
      data: { status: parsed.data.status },
    });

    revalidateProductViews(parsed.data.productId);
  } catch (error) {
    actionErrorMessage(error, "updateProductStatus");
  }
}

export async function deleteProduct(formData: FormData) {
  const user = await requireUser();
  const productId = String(formData.get("productId") ?? "");

  if (!productId) {
    redirect("/my/products");
  }

  const product = await prisma.product.findFirst({
    where: {
      id: productId,
      sellerId: user.id,
      deletedAt: null,
    },
    select: { id: true },
  });

  if (!product) {
    redirect("/my/products");
  }

  try {
    await prisma.product.update({
      where: { id: productId },
      data: {
        status: "OFFLINE",
        deletedAt: new Date(),
      },
    });

    // 软删除商品时标记其图片资源待删除（对象由 cleanup 异步物理清理）
    const images = await prisma.productImage.findMany({
      where: { productId },
      select: { url: true },
    });
    if (images.length > 0) {
      await markAssetsForValuesPendingDelete(
        user.id,
        images.map((image) => image.url),
      ).catch(() => undefined);
    }

    revalidateProductViews(productId);
  } catch (error) {
    actionErrorMessage(error, "deleteProduct");
  }

  redirect("/my/products");
}

export async function toggleFavorite(formData: FormData) {
  try {
    const user = await requireUser();
    const productId = String(formData.get("productId") ?? "");

    if (!productId) {
      return;
    }

    const product = await prisma.product.findFirst({
      where: {
        id: productId,
        deletedAt: null,
      },
      select: { id: true },
    });

    if (!product) {
      return;
    }

    // 同一事务内的删除/新建 + 计数增减，并发下保持一致
    await withTransaction(async (tx) =>
      applyFavoriteToggle({
        deleteFavorite: () =>
          tx.favorite.deleteMany({
            where: { userId: user.id, productId },
          }),
        createFavorite: () =>
          tx.favorite.create({
            data: { userId: user.id, productId },
          }),
        decrementCount: () =>
          tx.product.update({
            where: { id: productId },
            data: { favoriteCount: { decrement: 1 } },
          }),
        incrementCount: () =>
          tx.product.update({
            where: { id: productId },
            data: { favoriteCount: { increment: 1 } },
          }),
      }),
    );

    revalidateProductViews(productId);
  } catch (error) {
    actionErrorMessage(error, "toggleFavorite");
  }
}
