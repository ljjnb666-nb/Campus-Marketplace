import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createReport, getPublicUserProfile } = vi.hoisted(() => ({
  createReport: vi.fn(),
  getPublicUserProfile: vi.fn(),
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

vi.mock("@/actions/trust", () => ({
  createReport,
}));

vi.mock("@/repositories/user-repository", () => ({
  getPublicUserProfile,
}));

vi.mock("@/components/trust/report-form", () => ({
  ReportForm: ({ targetUserId, targetType }: { targetUserId: string; targetType: string }) => (
    <div>
      <p>举报对象 {targetType}</p>
      <p>举报用户 {targetUserId}</p>
    </div>
  ),
}));

vi.mock("@/components/product/product-card", () => ({
  ProductCard: ({ title }: { title: string }) => <p>{title}</p>,
}));

vi.mock("@/components/errand/errand-card", () => ({
  ErrandCard: ({ title }: { title: string }) => <p>{title}</p>,
}));

vi.mock("@/components/service/service-card", () => ({
  ServiceCard: ({ title }: { title: string }) => <p>{title}</p>,
}));

import PublicUserPage from "@/app/users/[id]/page";

afterEach(() => {
  cleanup();
});

describe("PublicUserPage", () => {
  it("renders empty states for a public user profile", async () => {
    getPublicUserProfile.mockResolvedValue({
      id: "user-1",
      name: "张同学",
      schoolName: "示例大学",
      campus: { name: "主校区" },
      avatarUrl: null,
      bio: null,
      verificationStatus: "VERIFIED",
      completedOrdersCount: 12,
      positiveReviewRate: 0.95,
      visibleCounts: {
        products: 0,
        createdErrandTasks: 0,
        serviceListings: 0,
      },
      college: null,
      grade: null,
      createdAt: new Date("2026-07-01T08:00:00.000Z"),
      products: [],
      createdErrandTasks: [],
      serviceListings: [],
    });

    render(
      await PublicUserPage({
        params: Promise.resolve({ id: "user-1" }),
      }),
    );

    expect(screen.getByRole("heading", { name: "张同学" })).toBeTruthy();
    expect(screen.getByText("这个同学很神秘，还没有填写个人简介。")).toBeTruthy();
  });

  it("renders user cards and section links when content exists", async () => {
    getPublicUserProfile.mockResolvedValue({
      id: "user-2",
      name: "李同学",
      schoolName: "示例大学",
      campus: { name: "东校区" },
      avatarUrl: "/uploads/avatar.jpg",
      bio: "负责教材整理",
      verificationStatus: "PENDING",
      completedOrdersCount: 5,
      positiveReviewRate: 0.9,
      visibleCounts: {
        products: 1,
        createdErrandTasks: 1,
        serviceListings: 1,
      },
      college: "计算机学院",
      grade: "2023级",
      createdAt: new Date("2026-07-02T08:00:00.000Z"),
      products: [
        {
          id: "product-1",
          title: "高数教材",
          description: "九成新。",
          price: 25,
          status: "ACTIVE",
          category: { name: "教材资料" },
          images: [],
          favoriteCount: 2,
        },
      ],
      createdErrandTasks: [
        {
          id: "errand-1",
          title: "代取快递",
          reward: 6,
          pickupLocation: "快递站",
          deliveryLocation: "宿舍",
          status: "OPEN",
        },
      ],
      serviceListings: [
        {
          id: "service-1",
          title: "PPT 美化",
          description: "答辩排版",
          price: 88,
          pricingUnit: "PER_ORDER",
          status: "ACTIVE",
          locationText: "线上",
          category: { name: "设计" },
          coverImageUrl: null,
          completedOrderCount: 3,
        },
      ],
    });

    render(
      await PublicUserPage({
        params: Promise.resolve({ id: "user-2" }),
      }),
    );

    expect(screen.getByText("负责教材整理")).toBeTruthy();
    expect(screen.getByText("高数教材")).toBeTruthy();
    expect(screen.getByText("代取快递")).toBeTruthy();
    expect(screen.getByText("PPT 美化")).toBeTruthy();
  });
});
