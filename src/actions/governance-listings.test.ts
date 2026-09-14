import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  moderateProductListingMock,
  moderateServiceListingMock,
  moderateErrandListingMock,
  moderateRentalListingMock,
  restoreListingByIdentityMock,
  revalidateMock,
  requireUserMock,
} = vi.hoisted(() => ({
  moderateProductListingMock: vi.fn(),
  moderateServiceListingMock: vi.fn(),
  moderateErrandListingMock: vi.fn(),
  moderateRentalListingMock: vi.fn(),
  restoreListingByIdentityMock: vi.fn(),
  revalidateMock: vi.fn(),
  requireUserMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidateMock,
}));

vi.mock("@/lib/revalidate", () => ({
  revalidateListingModerationViews: revalidateMock,
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser: requireUserMock,
}));

vi.mock("@/lib/moderation/listing-moderation-service", () => ({
  moderateProductListing: moderateProductListingMock,
  moderateServiceListing: moderateServiceListingMock,
  moderateErrandListing: moderateErrandListingMock,
  moderateRentalListing: moderateRentalListingMock,
  restoreListingByModerationIdentity: restoreListingByIdentityMock,
}));

import {
  moderateErrandListingAction,
  moderateProductListingAction,
  moderateRentalListingAction,
  moderateServiceListingAction,
  restoreListingModerationAction,
} from "@/actions/governance-listings";

function formData(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    data.set(key, value);
  }
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserMock.mockResolvedValue({ id: "moderator-1", name: " moderator " });
  moderateProductListingMock.mockResolvedValue({ outcome: "TAKEDOWN", moderationId: "m-1" });
  revalidateMock.mockReturnValue(undefined);
});

describe("Phase 7C governance-listings actions（R2-03/R2-06 冻结映射）", () => {
  it("takedown 成功 → canonical 调用 + revalidate（type/listingId 服务器侧）", async () => {
    const result = await moderateProductListingAction(
      formData({ listingId: "product-1", reasonCode: "PROHIBITED_ITEM", note: " 违禁 " }),
    );

    expect(result).toEqual({ success: true, message: "已对该内容执行治理处置" });
    expect(moderateProductListingMock).toHaveBeenCalledWith({
      moderatorId: "moderator-1",
      listingId: "product-1",
      reasonCode: "PROHIBITED_ITEM",
      note: "违禁",
    });
    expect(revalidateMock).toHaveBeenCalledWith("PRODUCT", "product-1");
  });

  it("takedown：注入 targetType/ownerId 等字段 → strict 拒绝 → 统一 deny，零 canonical 调用", async () => {
    const result = await moderateProductListingAction(
      formData({
        listingId: "product-1",
        reasonCode: "OTHER",
        targetType: "RENTAL",
        ownerId: "attacker",
        campusId: "campus-x",
      }),
    );

    expect(result).toEqual({ success: false, message: "没有权限执行该治理操作" });
    expect(moderateProductListingMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("授权族拒绝 → 统一 deny 文案（授权结构不可暴露）", async () => {
    const { rbacError } = await import("@/lib/rbac/errors");
    moderateProductListingMock.mockRejectedValue(rbacError("AUTH_PERMISSION_DENIED"));

    const result = await moderateProductListingAction(
      formData({ listingId: "product-1", reasonCode: "OTHER" }),
    );

    expect(result).toEqual({ success: false, message: "没有权限执行该治理操作" });
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("STALE → stale 标记 + 刷新提示（UI 不自动重试）；零 revalidate", async () => {
    const { ModerationError } = await import("@/lib/moderation/errors");
    moderateProductListingMock.mockRejectedValue(new ModerationError("STALE_MODERATION_REVIEW"));

    const result = await moderateProductListingAction(
      formData({ listingId: "product-1", reasonCode: "OTHER" }),
    );

    expect(result).toEqual({
      success: false,
      stale: true,
      message: "处置状态已变化，请刷新治理详情后重试",
    });
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("restore：仅提交 moderationId + expectedListingUpdatedAt → identity 解析 → 按 type/listingId revalidate", async () => {
    restoreListingByIdentityMock.mockResolvedValue({
      outcome: "RESTORED",
      moderationId: "m-1",
      targetType: "PRODUCT",
      listingId: "product-1",
    });

    const result = await restoreListingModerationAction(
      formData({
        moderationId: "m-1",
        expectedListingUpdatedAt: "2026-09-13T10:00:00.000Z",
      }),
    );

    expect(result).toEqual({ success: true, message: "已恢复该内容的公开展示" });
    expect(restoreListingByIdentityMock).toHaveBeenCalledWith({
      moderatorId: "moderator-1",
      moderationId: "m-1",
      expectedListingUpdatedAt: new Date("2026-09-13T10:00:00.000Z"),
    });
    expect(revalidateMock).toHaveBeenCalledWith("PRODUCT", "product-1");
  });

  it("restore：NOT_RESTORABLE → 泛化文案（不泄露 owner 注销事实）", async () => {
    const { ModerationError } = await import("@/lib/moderation/errors");
    restoreListingByIdentityMock.mockRejectedValue(new ModerationError("RESTORE_NOT_RESTORABLE"));

    const result = await restoreListingModerationAction(
      formData({
        moderationId: "m-1",
        expectedListingUpdatedAt: "2026-09-13T10:00:00.000Z",
      }),
    );

    expect(result).toEqual({ success: false, message: "该处置当前不可恢复" });
    expect(result.message).not.toContain("注销");
  });
});

describe("Phase 7C governance-listings actions：四域 dispatch 映射", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUserMock.mockResolvedValue({ id: "moderator-1", name: "审核员" });
    revalidateMock.mockReturnValue(undefined);
  });

  it("SERVICE/ERRAND/RENTAL action → 各自 canonical seam + 对应 revalidate", async () => {
    moderateServiceListingMock.mockResolvedValue({ outcome: "TAKEDOWN", moderationId: "m-s" });
    moderateErrandListingMock.mockResolvedValue({ outcome: "ALREADY_MODERATED", moderationId: "m-e" });
    moderateRentalListingMock.mockResolvedValue({ outcome: "TAKEDOWN", moderationId: "m-r" });

    const fd = (id: string) => {
      const data = new FormData();
      data.set("listingId", id);
      data.set("reasonCode", "OTHER");
      return data;
    };

    await moderateServiceListingAction(fd("service-1"));
    expect(moderateServiceListingMock).toHaveBeenCalledWith(
      expect.objectContaining({ moderatorId: "moderator-1", listingId: "service-1" }),
    );
    expect(revalidateMock).toHaveBeenCalledWith("SERVICE", "service-1");

    const errandResult = await moderateErrandListingAction(fd("errand-1"));
    expect(errandResult.message).toBe("该内容已在治理处置中");
    expect(revalidateMock).toHaveBeenCalledWith("ERRAND", "errand-1");

    await moderateRentalListingAction(fd("rental-1"));
    expect(revalidateMock).toHaveBeenCalledWith("RENTAL", "rental-1");
  });

  it("takedown note 缺省 → null 传递；canonical 抛错 → deny", async () => {
    const { moderationError } = await import("@/lib/moderation/errors");
    moderateProductListingMock.mockRejectedValue(moderationError("MODERATION_TARGET_NOT_FOUND"));
    const fd = new FormData();
    fd.set("listingId", "product-404");
    fd.set("reasonCode", "OTHER");
    const result = await moderateProductListingAction(fd);
    expect(result).toEqual({ success: false, message: "没有权限执行该治理操作" });
    expect(moderateProductListingMock).toHaveBeenCalledWith(
      expect.objectContaining({ note: null }),
    );
  });
});
