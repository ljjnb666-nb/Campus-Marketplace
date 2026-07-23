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
    $transaction: transactionMock,
  },
}));

import { createProduct, deleteProduct, updateProduct } from "@/actions/product";

function buildValidProductFormData() {
  const formData = new FormData();
  formData.set("title", "九成新概率论教材");
  formData.set("description", "书页干净无笔记，支持校内当面交易。");
  formData.set("price", "25");
  formData.set("originalPrice", "48");
  formData.set("categoryId", "category-1");
  formData.set("condition", "LIKE_NEW");
  formData.set("locationText", "图书馆门口");
  formData.append(
    "imageUrls",
    "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1200&q=80",
  );

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
    transactionMock.mockReset();

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT" });
    containsBannedKeyword.mockResolvedValue(null);
    saveUploadedImage.mockResolvedValue("/uploads/products/product.jpg");
    userFindUnique.mockResolvedValue({ campusId: "campus-1" });
    productCreate.mockResolvedValue({ id: "product-1" });
    transactionMock.mockResolvedValue([]);
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
});
