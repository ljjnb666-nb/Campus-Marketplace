import { beforeEach, describe, expect, it, vi } from "vitest";

const { membershipFindMany, membershipFindFirst } = vi.hoisted(() => ({
  membershipFindMany: vi.fn(),
  membershipFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    campusMembership: { findMany: membershipFindMany },
  },
}));

import {
  markMembershipsLeft,
  resolveActiveCampusMembership,
  requireActiveCampusMembership,
} from "@/lib/campus/membership-service";

const ACTIVE_MEMBERSHIP = {
  id: "m-1",
  userId: "user-1",
  campusId: "campus-a",
  status: "ACTIVE",
};

beforeEach(() => {
  membershipFindMany.mockReset().mockResolvedValue([]);
  membershipFindFirst.mockReset().mockResolvedValue(null);
});

describe("resolveActiveCampusMembership（中央 resolver）", () => {
  it("resolves the active membership with deterministic ordering", async () => {
    membershipFindMany.mockResolvedValue([ACTIVE_MEMBERSHIP]);

    const membership = await resolveActiveCampusMembership("user-1");

    expect(membership).toEqual(ACTIVE_MEMBERSHIP);
    expect(membershipFindMany).toHaveBeenCalledWith({
      where: { userId: "user-1", status: "ACTIVE" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 1,
    });
  });

  it("supports an explicit campus filter", async () => {
    membershipFindMany.mockResolvedValue([]);

    await resolveActiveCampusMembership("user-1", { campusId: "campus-b" });

    expect(membershipFindMany).toHaveBeenCalledWith({
      where: { userId: "user-1", status: "ACTIVE", campusId: "campus-b" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 1,
    });
  });

  it("returns null when the membership is missing or not ACTIVE", async () => {
    await expect(resolveActiveCampusMembership("user-1")).resolves.toBeNull();
  });
});

describe("requireActiveCampusMembership（fail closed）", () => {
  it("throws MEMBERSHIP_NOT_ACTIVE when no active membership exists", async () => {
    await expect(requireActiveCampusMembership("user-1")).rejects.toMatchObject({
      code: "MEMBERSHIP_NOT_ACTIVE",
    });
  });

  it("returns the membership when active", async () => {
    membershipFindMany.mockResolvedValue([ACTIVE_MEMBERSHIP]);

    await expect(requireActiveCampusMembership("user-1")).resolves.toEqual(ACTIVE_MEMBERSHIP);
  });
});

describe("markMembershipsLeft（注销闭环）", () => {
  it("flips all non-LEFT memberships to LEFT inside the caller's transaction", async () => {
    const tx = {
      campusMembership: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const count = await markMembershipsLeft(
      tx as unknown as Parameters<typeof markMembershipsLeft>[0],
      "user-1",
    );

    expect(count).toBe(1);
    expect(tx.campusMembership.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", status: { not: "LEFT" } },
      data: { status: "LEFT" },
    });
  });
});
