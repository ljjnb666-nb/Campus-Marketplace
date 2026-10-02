import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MyFavoritesPage from "@/app/my/favorites/page";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/product/product-card", () => ({
  ProductCard: ({
    title,
    price,
    seller,
  }: {
    title: string;
    price: string;
    seller: string;
  }) => (
    <article>
      <h2>{title}</h2>
      <p>{price}</p>
      <p>{seller}</p>
    </article>
  ),
}));

vi.mock("@/components/errand/errand-card", () => ({
  ErrandCard: ({
    id,
    title,
    publisher,
  }: {
    id: string;
    title: string;
    publisher: string;
  }) => (
    <article>
      <h2>{title}</h2>
      <p>{publisher}</p>
      <a href={`/errands/${id}`}>errand-detail-link</a>
    </article>
  ),
}));

vi.mock("@/components/service/service-card", () => ({
  ServiceCard: ({
    id,
    title,
    provider,
  }: {
    id: string;
    title: string;
    provider: string;
  }) => (
    <article>
      <h2>{title}</h2>
      <p>{provider}</p>
      <a href={`/services/${id}`}>service-detail-link</a>
    </article>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MyFavoritesPage Unified Component Suite", () => {
  beforeEach(() => {
    global.fetch = vi.fn((url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/api/favorites/products")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ favorites: [] }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ favorites: [] }),
      } as Response);
    });
  });

  it("renders empty state when there are no product favorites", async () => {
    render(<MyFavoritesPage />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "我的收藏" })).toBeTruthy();
      expect(screen.getByText("暂无收藏")).toBeTruthy();
    });
  });

  it("renders favorite products when API returns list", async () => {
    global.fetch = vi.fn((url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/api/favorites/products")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              favorites: [
                {
                  id: "favorite-1",
                  product: {
                    id: "product-1",
                    title: "高数教材",
                    description: "九成新教材",
                    price: "35.00",
                    status: "ACTIVE",
                    category: { name: "教材资料" },
                    seller: { name: "张同学" },
                    images: [{ url: "/uploads/products/book.jpg" }],
                    favoriteCount: 8,
                  },
                },
              ],
            }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ favorites: [] }),
      } as Response);
    });

    render(<MyFavoritesPage />);

    await waitFor(() => {
      expect(screen.getByText("高数教材")).toBeTruthy();
      expect(screen.getByText("张同学")).toBeTruthy();
    });
  });

  // RB01 review repair（Phase 8F §9/§10/§11）：API projection = exposure
  // state only。/my/favorites 只渲染 server read query 返回的收藏——
  // wind-down listing（OFFLINE/PAUSED/CLAIMED/COMPLETED）不进入 API payload，
  // 因此其 title 不得出现在 DOM；同时 UI 层不产生 raw enum 兜底渲染
  //（authority 在 server read query，不在客户端 filter）。
  it("does not render wind-down listing titles or raw status enums (favorite read projection contract)", async () => {
    global.fetch = vi.fn((url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/api/favorites/products")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              favorites: [
                {
                  id: "favorite-active",
                  product: {
                    id: "product-active",
                    title: "在售高数教材",
                    description: "九成新教材",
                    price: "35.00",
                    status: "ACTIVE",
                    category: { name: "教材资料" },
                    seller: { name: "张同学" },
                    images: [{ url: "/uploads/products/book.jpg" }],
                    favoriteCount: 8,
                  },
                },
              ],
            }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ favorites: [] }),
      } as Response);
    });

    render(<MyFavoritesPage />);

    await waitFor(() => {
      expect(screen.getByText("在售高数教材")).toBeTruthy();
    });

    // wind-down title 不渲染（server projection 不返回即不可见）
    expect(screen.queryByText("已下架的教材")).toBeNull();
    expect(screen.queryByText("已暂停的服务")).toBeNull();
    // §11：UI 层无 raw enum 泄漏（不因 hidden favorite fallback 渲染状态）
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toContain("OFFLINE");
    expect(bodyText).not.toContain("PAUSED");
    expect(bodyText).not.toContain("CLAIMED");
    expect(bodyText).not.toContain("COMPLETED");
  });

  it("renders errand and service favorites through shared cards after switching tabs", async () => {
    global.fetch = vi.fn((url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/api/favorites/errands")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              favorites: [
                {
                  id: "favorite-errand-1",
                  errandTask: {
                    id: "errand-1",
                    title: "代取快递",
                    description: "帮忙取一个快递",
                    reward: "5.00",
                    status: "OPEN",
                    category: { name: "代取快递" },
                    pickupLocation: "东门快递站",
                    deliveryLocation: "5号宿舍楼",
                    publisher: { name: "李同学", verificationStatus: "VERIFIED" },
                    deadline: "2026-08-20T12:00:00.000Z",
                  },
                },
              ],
            }),
        } as Response);
      }
      if (urlStr.includes("/api/favorites/services")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              favorites: [
                {
                  id: "favorite-service-1",
                  serviceListing: {
                    id: "service-1",
                    title: "吉他陪练",
                    description: "一对一陪练",
                    price: "80.00",
                    coverImage: "/uploads/services/guitar.jpg",
                    status: "ACTIVE",
                    pricingUnit: "PER_HOUR",
                    category: { name: "乐器" },
                    provider: { name: "王同学", verificationStatus: "VERIFIED" },
                    locationText: "大学生活动中心",
                    favoriteCount: 3,
                  },
                },
              ],
            }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ favorites: [] }),
      } as Response);
    });

    render(<MyFavoritesPage />);

    fireEvent.click(screen.getByRole("button", { name: /跑腿任务/ }));
    await waitFor(() => {
      expect(screen.getByText("代取快递")).toBeTruthy();
      expect(screen.getByText("李同学")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /技能服务/ }));
    await waitFor(() => {
      expect(screen.getByText("吉他陪练")).toBeTruthy();
      expect(screen.getByText("王同学")).toBeTruthy();
    });
  });
});
