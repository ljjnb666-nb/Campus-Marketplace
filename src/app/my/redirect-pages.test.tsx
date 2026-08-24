import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect,
}));

import MyOwnerOrdersRedirectPage from "@/app/my/owner-orders/page";
import RentalFavoritesRedirect from "@/app/my/rental-favorites/page";
import MyRentalOrdersRedirectPage from "@/app/my/rental-orders/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("租赁订单入口重定向页", () => {
  it("出租方订单入口跳转到统一订单中心", async () => {
    await MyOwnerOrdersRedirectPage();

    expect(redirect).toHaveBeenCalledWith("/my/orders?type=rental-owner");
  });

  it("租赁收藏入口跳转到统一收藏页", async () => {
    await RentalFavoritesRedirect();

    expect(redirect).toHaveBeenCalledWith("/my/favorites");
  });

  it("租客订单入口跳转到统一订单中心", async () => {
    await MyRentalOrdersRedirectPage();

    expect(redirect).toHaveBeenCalledWith("/my/orders?type=rental-renter");
  });
});
