import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  getServiceDetail,
  createOrOpenServiceConversation,
  createServiceOrder,
  deleteService,
  updateServiceStatus,
  createReport,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  getServiceDetail: vi.fn(),
  createOrOpenServiceConversation: vi.fn(),
  createServiceOrder: vi.fn(),
  deleteService: vi.fn(),
  updateServiceStatus: vi.fn(),
  createReport: vi.fn(),
}));

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

vi.mock("@/lib/auth", () => ({
  auth,
}));

vi.mock("@/repositories/service-repository", () => ({
  getServiceDetail,
}));

vi.mock("@/actions/conversation", () => ({
  createOrOpenServiceConversation,
}));

vi.mock("@/actions/order", () => ({
  createServiceOrder,
}));

vi.mock("@/actions/service", () => ({
  deleteService,
  updateServiceStatus,
}));

vi.mock("@/actions/trust", () => ({
  createReport,
}));

import ServiceDetailPage, { generateMetadata } from "@/app/services/[id]/page";

afterEach(() => {
  cleanup();
});

function buildServiceDetail() {
  return {
    service: {
      id: "service-1",
      providerId: "provider-1",
      title: "PPT 美化",
      price: "88.00",
      pricingUnit: "PER_ORDER",
      description: "答辩排版与演示优化。",
      locationText: "线上交接",
      availableSchedule: "周末全天",
      completedOrderCount: 10,
      averageRating: 4.8,
      createdAt: new Date("2026-07-05T08:00:00.000Z"),
      status: "ACTIVE",
      coverImageUrl: null,
      category: { name: "设计", slug: "design" },
      campus: { schoolName: "示例大学", name: "主校区" },
      provider: {
        id: "provider-1",
        name: "张同学",
        schoolName: "示例大学",
        completedOrdersCount: 12,
        positiveReviewRate: 0.97,
        createdAt: new Date("2026-01-02T08:00:00.000Z"),
      },
    },
    relatedServices: [
      {
        id: "service-2",
        title: "海报设计",
        description: "活动宣传",
        price: "66.00",
        pricingUnit: "PER_ORDER",
        status: "ACTIVE",
        provider: { name: "李同学" },
        locationText: "线上",
        category: { name: "设计" },
        coverImageUrl: null,
        completedOrderCount: 4,
        reason: "同类服务推荐",
      },
    ],
  };
}

describe("ServiceDetailPage Test Suite", () => {
  it("renders service owner controls, pricing unit and provider card", async () => {
    auth.mockResolvedValue({ user: { id: "provider-1" } });
    getServiceDetail.mockResolvedValue(buildServiceDetail());

    render(
      await ServiceDetailPage({
        params: Promise.resolve({ id: "service-1" }),
      }),
    );

    // 验证标题与计费单位
    expect(screen.getAllByText("PPT 美化")[0]).toBeTruthy();
    expect(screen.getAllByText(/88\.00/)[0]).toBeTruthy();
    expect(screen.getByText("线上交接")).toBeTruthy();

    // 验证服务者信息与按键
    expect(screen.getByText("张同学")).toBeTruthy();
    expect(screen.getByRole("link", { name: "编辑服务" }).getAttribute("href")).toBe(
      "/services/service-1/edit",
    );
    expect(screen.getByRole("button", { name: "删除服务" })).toBeTruthy();
  });

  it("renders booking button and chat entry for potential clients", async () => {
    auth.mockResolvedValue({ user: { id: "buyer-1" } });
    getServiceDetail.mockResolvedValue(buildServiceDetail());

    render(
      await ServiceDetailPage({
        params: Promise.resolve({ id: "service-1" }),
      }),
    );

    expect(screen.getAllByRole("button", { name: "预约服务" })[0]).toBeTruthy();
    expect(screen.getByRole("button", { name: "私聊服务者" })).toBeTruthy();
    expect(screen.getByText("同类服务推荐")).toBeTruthy();
  });
});

describe("ServiceDetailPage generateMetadata", () => {
  it("returns SEO metadata from the service detail", async () => {
    getServiceDetail.mockResolvedValue(buildServiceDetail());

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: "service-1" }),
    });

    expect(metadata.title).toBe("PPT 美化 - 校园集市");
    expect(metadata.description).toBe("答辩排版与演示优化。");
    expect(metadata.openGraph?.title).toBe("PPT 美化 - 校园集市");
  });

  it("falls back to generic metadata when the service is missing", async () => {
    getServiceDetail.mockRejectedValue(new Error("notFound"));

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: "missing-service" }),
    });

    expect(metadata.title).toBe("技能服务详情 - 校园集市");
  });
});
