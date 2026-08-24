import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  notFound,
  errandTaskFindMany,
  errandTaskCount,
  errandTaskFindFirst,
  errandCategoryFindMany,
} = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  errandTaskFindMany: vi.fn(),
  errandTaskCount: vi.fn(),
  errandTaskFindFirst: vi.fn(),
  errandCategoryFindMany: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    errandTask: {
      findMany: errandTaskFindMany,
      count: errandTaskCount,
      findFirst: errandTaskFindFirst,
    },
    errandCategory: {
      findMany: errandCategoryFindMany,
    },
  },
}));

import {
  getErrandDetail,
  getErrandForEdit,
  getErrandFormMeta,
  getErrandList,
  getMyAcceptedErrands,
  getMyPublishedErrands,
} from "@/repositories/errand-repository";

describe("errand repository", () => {
  beforeEach(() => {
    errandTaskFindMany.mockReset();
    errandTaskCount.mockReset();
    errandTaskFindFirst.mockReset();
    errandCategoryFindMany.mockReset();
  });

  it("builds errand list filters, sorting, deadline window and categories", async () => {
    errandTaskFindMany.mockResolvedValue([{ id: "errand-1" }]);
    errandTaskCount.mockResolvedValue(13);
    errandCategoryFindMany.mockResolvedValue([{ id: "category-1", name: "代取快递" }]);

    const result = await getErrandList({
      q: "快递",
      category: "category-1",
      status: "OPEN",
      deadline: "3days",
      sort: "reward_desc",
      page: 2,
    });

    expect(errandTaskFindMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        OR: [
          { title: { contains: "快递", mode: "insensitive" } },
          { description: { contains: "快递", mode: "insensitive" } },
          { pickupLocation: { contains: "快递", mode: "insensitive" } },
          { deliveryLocation: { contains: "快递", mode: "insensitive" } },
        ],
        categoryId: "category-1",
        status: "OPEN",
        deadline: {
          gte: expect.any(Date),
          lte: expect.any(Date),
        },
      },
      orderBy: [
        { reward: "desc" },
        { createdAt: "desc" },
      ],
      skip: 12,
      take: 12,
      include: {
        category: true,
        publisher: {
          select: {
            id: true,
            name: true,
            schoolName: true,
            verificationStatus: true,
          },
        },
        accepter: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
    expect(errandCategoryFindMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    });
    expect(result).toEqual({
      items: [{ id: "errand-1" }],
      total: 13,
      categories: [{ id: "category-1", name: "代取快递" }],
      page: 2,
      pageSize: 12,
      totalPages: 2,
    });
  });

  it("defaults to first page and latest sorting without filters", async () => {
    errandTaskFindMany.mockResolvedValue([]);
    errandTaskCount.mockResolvedValue(0);
    errandCategoryFindMany.mockResolvedValue([]);

    const result = await getErrandList();

    const findArgs = errandTaskFindMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ deletedAt: null });
    expect(findArgs.orderBy).toEqual([{ createdAt: "desc" }]);
    expect(findArgs.skip).toBe(0);
    expect(result.totalPages).toBe(1);
  });

  it("ignores ALL status shorthand so every status is included", async () => {
    errandTaskFindMany.mockResolvedValue([]);
    errandTaskCount.mockResolvedValue(0);
    errandCategoryFindMany.mockResolvedValue([]);

    await getErrandList({ status: "ALL" });

    expect(errandTaskFindMany.mock.calls[0][0].where).toEqual({ deletedAt: null });
  });

  it("loads form meta with active categories only", async () => {
    errandCategoryFindMany.mockResolvedValue([{ id: "category-1", name: "代取快递", slug: "pickup" }]);

    const result = await getErrandFormMeta();

    expect(result).toEqual({
      categories: [{ id: "category-1", name: "代取快递", slug: "pickup" }],
    });
    expect(errandCategoryFindMany.mock.calls[0][0].where).toEqual({ isActive: true });
  });

  it("returns errand detail with ranked related errands", async () => {
    const base = {
      campusId: "campus-1",
      categoryId: "category-1",
      pickupLocation: "图书馆",
      deliveryLocation: "宿舍区",
    };
    errandTaskFindFirst.mockResolvedValue({
      id: "errand-1",
      ...base,
    });
    errandTaskFindMany.mockResolvedValue([
      { id: "same-campus-category", ...base, reward: { toString: () => "10" }, deadline: new Date(), publisher: { verificationStatus: "VERIFIED" }, createdAt: new Date() },
      { id: "other", campusId: "campus-2", categoryId: "category-2", pickupLocation: "东门", deliveryLocation: "西门", reward: { toString: () => "5" }, deadline: new Date(), publisher: { verificationStatus: "UNVERIFIED" }, createdAt: new Date() },
    ]);

    const result = await getErrandDetail("errand-1");

    expect(result.errand.id).toBe("errand-1");
    const recommendationArgs = errandTaskFindMany.mock.calls[0][0];
    expect(recommendationArgs.where.id).toEqual({ not: "errand-1" });
    expect(recommendationArgs.where.status).toBe("OPEN");
    expect(result.relatedErrands).toHaveLength(2);
    expect(result.relatedErrands[0].id).toBe("same-campus-category");
    expect(result.relatedErrands[0].reason).toBe("同校区同分类");
  });

  it("throws notFound for missing errand detail", async () => {
    errandTaskFindFirst.mockResolvedValue(null);

    await expect(getErrandDetail("missing")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("scopes errand edit lookups to the publisher", async () => {
    errandTaskFindFirst.mockResolvedValue({ id: "errand-1" });

    const errand = await getErrandForEdit("errand-1", "user-1");

    expect(errand).toEqual({ id: "errand-1" });
    expect(errandTaskFindFirst.mock.calls[0][0].where).toEqual({
      id: "errand-1",
      publisherId: "user-1",
      deletedAt: null,
    });
  });

  it("throws notFound when editing another user's errand", async () => {
    errandTaskFindFirst.mockResolvedValue(null);

    await expect(getErrandForEdit("errand-1", "user-2")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("lists published errands with accepter summaries", async () => {
    errandTaskFindMany.mockResolvedValue([{ id: "errand-1" }]);

    const items = await getMyPublishedErrands("user-1");

    expect(items).toEqual([{ id: "errand-1" }]);
    const args = errandTaskFindMany.mock.calls[0][0];
    expect(args.where).toEqual({ publisherId: "user-1", deletedAt: null });
    expect(args.orderBy).toEqual({ createdAt: "desc" });
    expect(args.include.accepter).toEqual({ select: { name: true } });
  });

  it("lists accepted errands ordered by recent activity", async () => {
    errandTaskFindMany.mockResolvedValue([{ id: "errand-2" }]);

    const items = await getMyAcceptedErrands("user-1");

    expect(items).toEqual([{ id: "errand-2" }]);
    const args = errandTaskFindMany.mock.calls[0][0];
    expect(args.where).toEqual({ accepterId: "user-1", deletedAt: null });
    expect(args.orderBy).toEqual({ updatedAt: "desc" });
    expect(args.include.publisher).toEqual({ select: { name: true } });
  });
});
