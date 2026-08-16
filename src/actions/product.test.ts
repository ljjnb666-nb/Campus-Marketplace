import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  redirect,
  revalidatePath,
  requireUser,
  containsBannedKeyword,
  saveUploadedImage,
  userFindUnique,
  productCategoryFindUnique,
  productFindFirst,
  productCreate,
  productUpdate,
  productImageDeleteMany,
  productImageCreateMany,
  favoriteDeleteMany,
  favoriteCreate,
  transactionMock,
} = vi.hoisted(() => ({
  redirect: vi.fn((location: string) => {
    throw new Error(`REDIRECT:${location}`);
  }),
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  containsBannedKeyword: vi.fn(),
  saveUploadedImage: vi.fn(),
  userFindUnique: vi.fn(),
  productCategoryFindUnique: vi.fn(),
  productFindFirst: vi.fn(),
  productCreate: vi.fn(),
  productUpdate: vi.fn(),
  productImageDeleteMany: vi.fn(),
  productImageCreateMany: vi.fn(),
  favoriteDeleteMany: vi.fn(),
  favoriteCreate: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("next/navigation", () => ({
  redirect,
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/lib/moderation", () => ({
  containsBannedKeyword,
}));

vi.mock("@/lib/upload", () => ({
  saveUploadedImage,
  isStoredImagePath: (value: string) => value.startsWith("/uploads/"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
    },
    productCategory: {
      findUnique: productCategoryFindUnique,
    },
    product: {
      create: productCreate,
      update: productUpdate,
      findFirst: productFindFirst,
    },
    productImage: {
      deleteMany: productImageDeleteMany,
      createMany: productImageCreateMany,
    },
    favorite: {
      deleteMany: favoriteDeleteMany,
      create: favoriteCreate,
    },
    $transaction: transactionMock,
  },
}));

import {
  createProduct,
  deleteProduct,
  toggleFavorite,
  updateProduct,
} from "@/actions/product";

function buildValidProductFormData() {
  const formData = new FormData();
  formData.set("title", "九成新概率论教材");
  formData.set("description", "书页干净无笔记，支持校内当面交易。");
  formData.set("price", "25");
  formData.set("originalPrice", "48");
  formData.set("categoryId", "category-1");
  formData.set("condition", "LIKE_NEW");
  formData.set("locationText", "图书馆门口");
  formData.append("imageUrls", "https://example.com/textbook.jpg");

  return formData;
}

describe("product actions", () => {
  beforeEach(() => {
    redirect.mockClear();
    revalidatePath.mockReset();
    requireUser.mockReset();
    containsBannedKeyword.mockReset();
    saveUploadedImage.mockReset();
    userFindUnique.mockReset();
    productCategoryFindUnique.mockReset();
    productFindFirst.mockReset();
    productCreate.mockReset();
    productUpdate.mockReset();
    productImageDeleteMany.mockReset();
    productImageCreateMany.mockReset();
    favoriteDeleteMany.mockReset();
    favoriteCreate.mockReset();
    transactionMock.mockReset();

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT" });
    containsBannedKeyword.mockResolvedValue(null);
    saveUploadedImage.mockResolvedValue("/uploads/products/product.jpg");
    userFindUnique.mockResolvedValue({ campusId: "campus-1" });
    productCreate.mockResolvedValue({ id: "product-1" });
    favoriteDeleteMany.mockResolvedValue({ count: 0 });
    favoriteCreate.mockResolvedValue({ id: "favorite-1" });
    productUpdate.mockResolvedValue({});
    // 数组形式照旧返回空数组；事务回调形式传入共享的 mock 委托
    transactionMock.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") {
        return arg({
          favorite: { deleteMany: favoriteDeleteMany, create: favoriteCreate },
          product: { update: productUpdate },
        });
      }
      return [];
    });
  });

  it("rejects product creation when the selected category is inactive", async () => {
    productCategoryFindUnique.mockResolvedValue({
      id: "category-1",
      isActive: false,
    });

    const result = await createProduct(
      { success: false, message: "" },
      buildValidProductFormData(),
    );

    expect(result).toEqual({
      success: false,
      message: "商品分类不存在或已停用",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("uses uploaded files in place of image urls when creating products", async () => {
    productCategoryFindUnique.mockResolvedValue({
      id: "category-1",
      isActive: true,
    });

    const formData = buildValidProductFormData();
    formData.delete("imageUrls");
    formData.append("imageUrls", "");
    formData.append("imageFiles", new File(["binary"], "product.png", { type: "image/png" }));

    await createProduct({ success: false, message: "" }, formData);

    expect(saveUploadedImage).toHaveBeenCalled();
    expect(productCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        images: {
          create: [
            {
              url: "/uploads/products/product.jpg",
              sortOrder: 0,
            },
          ],
        },
      }),
    });
  });

  it("rejects product update when the selected category is inactive", async () => {
    productFindFirst.mockResolvedValue({ id: "product-1" });
    productCategoryFindUnique.mockResolvedValue({
      id: "category-1",
      isActive: false,
    });

    const formData = buildValidProductFormData();
    formData.set("productId", "product-1");

    const result = await updateProduct({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: false,
      message: "商品分类不存在或已停用",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("soft deletes the owner's product and redirects back to my products", async () => {
    productFindFirst.mockResolvedValue({ id: "product-1" });

    const formData = new FormData();
    formData.set("productId", "product-1");

    await expect(deleteProduct(formData)).rejects.toThrow("REDIRECT:/my/products");

    expect(productUpdate).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: {
        status: "OFFLINE",
        deletedAt: expect.any(Date),
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/products/product-1");
    expect(revalidatePath).toHaveBeenCalledWith("/my/products");
  });

  it("does not delete products owned by other users", async () => {
    productFindFirst.mockResolvedValue(null);

    const formData = new FormData();
    formData.set("productId", "product-1");

    await expect(deleteProduct(formData)).rejects.toThrow("REDIRECT:/my/products");

    expect(productUpdate).not.toHaveBeenCalled();
  });

  describe("toggleFavorite", () => {
    function buildFavoriteFormData(productId = "product-1") {
      const formData = new FormData();
      formData.set("productId", productId);
      return formData;
    }

    it("adds a favorite for the session user inside one transaction", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1" });
      favoriteDeleteMany.mockResolvedValue({ count: 0 });

      await toggleFavorite(buildFavoriteFormData());

      expect(transactionMock).toHaveBeenCalledTimes(1);
      expect(favoriteDeleteMany).toHaveBeenCalledWith({
        where: { userId: "user-1", productId: "product-1" },
      });
      expect(favoriteCreate).toHaveBeenCalledWith({
        data: { userId: "user-1", productId: "product-1" },
      });
      expect(productUpdate).toHaveBeenCalledWith({
        where: { id: "product-1" },
        data: { favoriteCount: { increment: 1 } },
      });
      expect(revalidatePath).toHaveBeenCalledWith("/products/product-1");
    });

    it("removes an existing favorite and only decrements once", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1" });
      favoriteDeleteMany.mockResolvedValue({ count: 1 });

      await toggleFavorite(buildFavoriteFormData());

      expect(productUpdate).toHaveBeenCalledWith({
        where: { id: "product-1" },
        data: { favoriteCount: { decrement: 1 } },
      });
      expect(productUpdate).toHaveBeenCalledTimes(1);
      expect(favoriteCreate).not.toHaveBeenCalled();
    });

    it("treats a concurrent create that loses the unique constraint race as idempotent", async () => {
      // 竞态模拟：另一个并发请求刚刚创建了收藏行
      productFindFirst.mockResolvedValue({ id: "product-1" });
      favoriteDeleteMany.mockResolvedValue({ count: 0 });
      favoriteCreate.mockRejectedValue(
        Object.assign(
          new Error("Unique constraint failed on the fields: (`userId`,`productId`)"),
          { code: "P2002" },
        ),
      );

      await expect(
        toggleFavorite(buildFavoriteFormData()),
      ).resolves.toBeUndefined();

      // create 失败时绝不能增减计数器，否则 favoriteCount 漂移
      expect(productUpdate).not.toHaveBeenCalled();
    });

    it("does nothing when the product does not exist", async () => {
      productFindFirst.mockResolvedValue(null);

      await toggleFavorite(buildFavoriteFormData());

      expect(favoriteDeleteMany).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it("does nothing when the product id is missing", async () => {
      await toggleFavorite(new FormData());

      expect(productFindFirst).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });
  });
});
