import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    moderationKeyword: {
      findMany,
    },
  },
}));

import { containsBannedKeyword } from "@/lib/moderation";

describe("containsBannedKeyword", () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it("uses enabled moderation keywords from the database first", async () => {
    findMany.mockResolvedValue([
      { keyword: "刷单" },
      { keyword: "代打卡" },
    ]);

    await expect(containsBannedKeyword("这个兼职其实是刷单项目")).resolves.toBe("刷单");
    expect(findMany).toHaveBeenCalledWith({
      where: { isEnabled: true },
      select: { keyword: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("falls back to built-in default keywords when the database list is empty", async () => {
    findMany.mockResolvedValue([]);

    await expect(containsBannedKeyword("这里提供论文代写服务")).resolves.toBe("论文代写");
  });

  it("returns null when no banned keyword is matched", async () => {
    findMany.mockResolvedValue([{ keyword: "刷单" }]);

    await expect(containsBannedKeyword("帮忙带饭，晚饭后送到宿舍楼下")).resolves.toBeNull();
  });
});
