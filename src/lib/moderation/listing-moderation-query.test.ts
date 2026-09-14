import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    listingModeration: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    product: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    serviceListing: { findUnique: vi.fn(), findMany: vi.fn() },
    errandTask: { findUnique: vi.fn(), findMany: vi.fn() },
    rentalListing: { findUnique: vi.fn(), findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  getActiveListingModeration,
  hasActiveListingModeration,
  listingModerationPublicFilter,
  rereadListingForConversation,
  resolvePublicDetailModerationGate,
  browseListings,
  loadActiveModerations,
  loadReportFlaggedListings,
} from "@/lib/moderation/listing-moderation-query";

/**
 * Phase 7C FR-05 branch 补全（Final Coverage Gate Repair）：
 * 仅覆盖真实决策分支——OPEN/OWNER_VIEW/HIDDEN 三态、
 * additionalAllowedViewerIds 命中/未命中、reread 四域行锁分支、
 * conversation moderation gate、keyset cursor 谓词结构、hasMore。
 * 全部断言行为，不做无断言执行。
 */

const tx = prismaMock as unknown as Parameters<typeof rereadListingForConversation>[0];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolvePublicDetailModerationGate（FR-03 三态）", () => {
  it("无活跃 moderation → OPEN（不区分 viewer）", async () => {
    prismaMock.listingModeration.findFirst.mockResolvedValue(null);
    await expect(
      resolvePublicDetailModerationGate({ viewerId: null, ownerId: "owner-1", targetType: "PRODUCT", listingId: "p1" }),
    ).resolves.toBe("OPEN");
  });

  it("活跃 moderation：owner 命中 → OWNER_VIEW；匿名 → HIDDEN", async () => {
    prismaMock.listingModeration.findFirst.mockResolvedValue({ id: "m-1", createdAt: new Date() });
    await expect(
      resolvePublicDetailModerationGate({ viewerId: "owner-1", ownerId: "owner-1", targetType: "PRODUCT", listingId: "p1" }),
    ).resolves.toBe("OWNER_VIEW");
    await expect(
      resolvePublicDetailModerationGate({ viewerId: null, ownerId: "owner-1", targetType: "PRODUCT", listingId: "p1" }),
    ).resolves.toBe("HIDDEN");
  });

  it("ERRAND accepter 履约白名单：命中 → OWNER_VIEW；非参与方 → HIDDEN；accepterId null 不放行", async () => {
    prismaMock.listingModeration.findFirst.mockResolvedValue({ id: "m-1", createdAt: new Date() });
    await expect(
      resolvePublicDetailModerationGate({
        viewerId: "accepter-1", ownerId: "publisher-1", additionalAllowedViewerIds: ["accepter-1"],
        targetType: "ERRAND", listingId: "e1",
      }),
    ).resolves.toBe("OWNER_VIEW");
    await expect(
      resolvePublicDetailModerationGate({
        viewerId: "stranger-1", ownerId: "publisher-1", additionalAllowedViewerIds: ["accepter-1"],
        targetType: "ERRAND", listingId: "e1",
      }),
    ).resolves.toBe("HIDDEN");
    await expect(
      resolvePublicDetailModerationGate({
        viewerId: "accepter-1", ownerId: "publisher-1", additionalAllowedViewerIds: [null],
        targetType: "ERRAND", listingId: "e1",
      }),
    ).resolves.toBe("HIDDEN");
  });
});

describe("rereadListingForConversation（四域行锁分支 + moderation gate）", () => {
  it("SERVICE 命中行 → 快照；活跃 moderation → null", async () => {
    prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join("|") : "";
      if (sql.includes("ServiceListing")) {
        return [{ id: "s1", campusId: "c1", ownerId: "p1", deletedAt: null }];
      }
      return [];
    });
    prismaMock.listingModeration.findFirst.mockResolvedValue(null);
    await expect(rereadListingForConversation(tx, "SERVICE", "s1")).resolves.toEqual({
      campusId: "c1", ownerId: "p1", counterpartId: null,
    });

    prismaMock.listingModeration.findFirst.mockResolvedValue({ id: "m-1", createdAt: new Date() });
    await expect(rereadListingForConversation(tx, "SERVICE", "s1")).resolves.toBeNull();
    prismaMock.listingModeration.findFirst.mockResolvedValue(null);
  });

  it("ERRAND：快照携带 counterpartId；RENTAL：无 counterpart 字段 → null", async () => {
    prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join("|") : "";
      if (sql.includes("ErrandTask")) {
        return [{ id: "e1", campusId: "c1", ownerId: "pub", counterpartId: "acc", deletedAt: null }];
      }
      if (sql.includes("RentalListing")) {
        return [{ id: "r1", campusId: "c1", ownerId: "own", deletedAt: null }];
      }
      return [];
    });
    prismaMock.listingModeration.findFirst.mockResolvedValue(null);
    await expect(rereadListingForConversation(tx, "ERRAND", "e1")).resolves.toEqual({
      campusId: "c1", ownerId: "pub", counterpartId: "acc",
    });
    await expect(rereadListingForConversation(tx, "RENTAL", "r1")).resolves.toEqual({
      campusId: "c1", ownerId: "own", counterpartId: null,
    });
    prismaMock.listingModeration.findFirst.mockResolvedValue(null);
  });

  it("行缺失 / 已软删 → null（资源不可用回退）", async () => {
    prismaMock.$queryRaw.mockImplementation(async () => []);
    await expect(rereadListingForConversation(tx, "PRODUCT", "gone")).resolves.toBeNull();
    prismaMock.$queryRaw.mockImplementation(async () => [
      { id: "p1", campusId: "c1", ownerId: "o1", deletedAt: new Date() },
    ]);
    await expect(rereadListingForConversation(tx, "PRODUCT", "p1")).resolves.toBeNull();
  });
});

describe("getActiveListingModeration / hasActiveListingModeration", () => {
  it("命中返回最小字段；未命中 → null / false", async () => {
    prismaMock.listingModeration.findFirst
      .mockResolvedValueOnce({ id: "m-1", createdAt: new Date() })
      .mockResolvedValueOnce(null);
    await expect(getActiveListingModeration(prismaMock, "PRODUCT", "p1")).resolves.toMatchObject({ id: "m-1" });
    await expect(hasActiveListingModeration(prismaMock, "PRODUCT", "p1")).resolves.toBe(false);
  });
});

describe("listingModerationPublicFilter（共享谓词形状）", () => {
  it("恒返回 moderations.none.resolvedAt:null 结构", () => {
    expect(listingModerationPublicFilter()).toEqual({
      moderations: { none: { resolvedAt: null } },
    });
  });
});

describe("queue loaders（FR-01 keyset + hasMore 行为）", () => {
  const access = { global: false, campusIds: ["campus-1"] };

  it("browseListings：hasMore=true 截断至 limit + 内部 cursor 元组", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `p${i}`,
      title: `t${i}`,
      status: "ACTIVE",
      createdAt: new Date(2026, 8, 1, 0, 0, 0, i),
      campus: { name: "主校区" },
      seller: { name: "卖家" },
      moderations: [],
      reports: [],
    }));
    prismaMock.product.findMany.mockImplementation(async (args: { take: number; where: Record<string, unknown> }) => {
      expect(args.take).toBe(3); // limit(2) + 1
      expect(args.where.deletedAt).toBeNull();
      expect(args.where.campusId).toEqual({ in: ["campus-1"] });
      return rows;
    });

    const page = await browseListings({ access, targetType: "PRODUCT", cursor: null, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.items[0]).toMatchObject({ cursorCreatedAt: rows[0].createdAt, cursorId: "p0" });

    // page2：cursor 存在时 keyset 谓词（OR）必须出现在 where 中
    prismaMock.product.findMany.mockImplementation(async (args: { take: number; where: Record<string, unknown> }) => {
      expect(args.where.OR).toEqual([
        { createdAt: { lt: rows[1].createdAt } },
        { AND: [{ createdAt: { equals: rows[1].createdAt } }, { id: { lt: rows[1].id } }] },
      ]);
      return [rows[2]];
    });
    const page2 = await browseListings({
      access,
      targetType: "PRODUCT",
      cursor: { createdAt: rows[1].createdAt, id: rows[1].id },
      limit: 2,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
  });

  it("browseListings：q 进入 where（title contains insensitive）", async () => {
    prismaMock.product.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
      expect(args.where.title).toEqual({ contains: "相机", mode: "insensitive" });
      return [];
    });
    const page = await browseListings({ access, targetType: "PRODUCT", q: "相机", cursor: null, limit: 2 });
    expect(page).toEqual({ items: [], hasMore: false });
  });

  it("loadReportFlaggedListings：reports some 谓词 + GLOBAL 无 campus 过滤", async () => {
    prismaMock.errandTask.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
      expect(args.where.campusId).toBeUndefined();
      expect(args.where.reports).toEqual({ some: { status: { in: ["OPEN", "IN_REVIEW"] } } });
      return [];
    });
    const page = await loadReportFlaggedListings({
      access: { global: true, campusIds: [] },
      targetType: "ERRAND",
      cursor: null,
      limit: 2,
    });
    expect(page.hasMore).toBe(false);
  });

  it("loadActiveModerations：keyset 谓词 + 元组截断", async () => {
    const findManyMock = vi.fn(async (args: {
      take: number;
      where: Record<string, unknown>;
    }) => {
      expect(args.take).toBe(3); // limit(2) + 1
      expect(args.where.resolvedAt).toBeNull();
      return [
        {
          id: "m-1",
          targetType: "PRODUCT",
          productId: "p1",
          serviceListingId: null,
          errandTaskId: null,
          rentalListingId: null,
          createdAt: new Date("2026-09-01T00:00:00Z"),
          reasonCode: "OTHER",
          campus: { name: "主校区" },
          moderator: { name: "审核员" },
          resolvedBy: null,
          product: { title: "商品", status: "ACTIVE", seller: { name: "卖家" } },
        },
        {
          id: "m-2",
          targetType: "PRODUCT",
          productId: "p2",
          serviceListingId: null,
          errandTaskId: null,
          rentalListingId: null,
          createdAt: new Date("2026-09-01T00:00:01Z"),
          reasonCode: "OTHER",
          campus: { name: "主校区" },
          moderator: { name: "审核员" },
          resolvedBy: null,
          product: { title: "商品2", status: "ACTIVE", seller: { name: "卖家" } },
        },
        {
          id: "m-3",
          targetType: "PRODUCT",
          productId: "p3",
          serviceListingId: null,
          errandTaskId: null,
          rentalListingId: null,
          createdAt: new Date("2026-09-01T00:00:02Z"),
          reasonCode: "OTHER",
          campus: { name: "主校区" },
          moderator: { name: "审核员" },
          resolvedBy: null,
          product: { title: "商品3", status: "ACTIVE", seller: { name: "卖家" } },
        },
      ];
    });
    prismaMock.listingModeration.findFirst.mockResolvedValue(null);
    prismaMock.listingModeration.findMany.mockImplementation(findManyMock);

    const page = await loadActiveModerations({ access, cursor: null, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.items[0].cursorId).toBe("m-1");
  });
});
