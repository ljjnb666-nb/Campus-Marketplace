"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { containsBannedKeyword } from "@/lib/moderation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";
import { saveUploadedImage } from "@/lib/upload";
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

async function extractImageUrls(formData: FormData) {
  const imageUrls = formData.getAll("imageUrls").map((value) => String(value).trim());
  const imageFiles = formData.getAll("imageFiles");

  const values = await Promise.all(
    Array.from({ length: Math.max(imageUrls.length, imageFiles.length) }, async (_, index) => {
      const file = imageFiles[index];

      if (file instanceof File && file.size > 0) {
        return saveUploadedImage(file, "product");
      }

      return imageUrls[index] || null;
    }),
  );

  return values.filter((value): value is string => Boolean(value));
}

function decimalValue(value: string) {
  return new Prisma.Decimal(value);
}

function applyProductPageRevalidation(productId?: string) {
  revalidatePath("/");
  revalidatePath("/products");
  revalidatePath("/my/products");
  revalidatePath("/my/favorites");

  if (productId) {
    revalidatePath(`/products/${productId}`);
    revalidatePath(`/products/${productId}/edit`);
  }
}

export async function createProduct(
  _prevState: ProductActionState | null,
  formData: FormData,
): Promise<ProductActionState> {
  const user = await requireUser();
  const imageUrls = await extractImageUrls(formData);

  const parsed = productFormSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description"),
    price: formData.get("price"),
    originalPrice: formData.get("originalPrice"),
    categoryId: formData.get("categoryId"),
    condition: formData.get("condition"),
    locationText: formData.get("locationText"),
    imageUrls,
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

  const product = await prisma.product.create({
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
      images: {
        create: parsed.data.imageUrls.map((url, index) => ({
          url,
          sortOrder: index,
        })),
      },
    },
  });

  applyProductPageRevalidation(product.id);

  return {
    success: true,
    message: "商品发布成功",
    redirectTo: `/products/${product.id}`,
  };
}

export async function updateProduct(
  _prevState: ProductActionState | null,
  formData: FormData,
): Promise<ProductActionState> {
  const user = await requireUser();
  const productId = String(formData.get("productId") ?? "");
  const imageUrls = await extractImageUrls(formData);

  const parsed = productFormSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description"),
    price: formData.get("price"),
    originalPrice: formData.get("originalPrice"),
    categoryId: formData.get("categoryId"),
    condition: formData.get("condition"),
    locationText: formData.get("locationText"),
    imageUrls,
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

  const [existingProduct, category] = await Promise.all([
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
  ]);

  if (!existingProduct) {
    return { ...initialState, message: "无权修改该商品" };
  }

  if (!category || !category.isActive) {
    return { ...initialState, message: "商品分类不存在或已停用" };
  }

  await prisma.$transaction([
    prisma.product.update({
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
    }),
    prisma.productImage.deleteMany({
      where: { productId },
    }),
    prisma.productImage.createMany({
      data: parsed.data.imageUrls.map((url, index) => ({
        productId,
        url,
        sortOrder: index,
      })),
    }),
  ]);

  applyProductPageRevalidation(productId);

  return {
    success: true,
    message: "商品已更新",
    redirectTo: `/products/${productId}`,
  };
}

export async function updateProductStatus(formData: FormData) {
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

  applyProductPageRevalidation(parsed.data.productId);
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

  await prisma.product.update({
    where: { id: productId },
    data: {
      status: "OFFLINE",
      deletedAt: new Date(),
    },
  });

  applyProductPageRevalidation(productId);
  redirect("/my/products");
}

export async function toggleFavorite(formData: FormData) {
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

  const existingFavorite = await prisma.favorite.findUnique({
    where: {
      userId_productId: {
        userId: user.id,
        productId,
      },
    },
  });

  await applyFavoriteToggle({
    existing: existingFavorite,
    remove: () => [
      prisma.favorite.delete({
        where: {
          userId_productId: {
            userId: user.id,
            productId,
          },
        },
      }),
      prisma.product.update({
        where: { id: productId },
        data: { favoriteCount: { decrement: 1 } },
      }),
    ],
    add: () => [
      prisma.favorite.create({
        data: {
          userId: user.id,
          productId,
        },
      }),
      prisma.product.update({
        where: { id: productId },
        data: { favoriteCount: { increment: 1 } },
      }),
    ],
  });

  applyProductPageRevalidation(productId);
}
