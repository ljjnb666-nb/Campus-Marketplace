import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { requireUser, getProfileDashboard, updateProfile } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getProfileDashboard: vi.fn(),
  updateProfile: vi.fn(),
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

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/user-repository", () => ({
  getProfileDashboard,
}));

vi.mock("@/actions/user", () => ({
  updateProfile,
}));

vi.mock("@/components/profile/profile-form", () => ({
  ProfileForm: ({
    action,
    initialValues,
  }: {
    action: unknown;
    initialValues: {
      name: string;
      bio?: string | null;
      college?: string | null;
      grade?: string | null;
      phone?: string | null;
      avatarUrl?: string | null;
    };
  }) => (
    <div data-action={action === updateProfile ? "matched" : "unmatched"}>
      <p>表单姓名 {initialValues.name}</p>
      <p>表单学院 {initialValues.college}</p>
      <p>表单年级 {initialValues.grade}</p>
      <p>表单手机号 {initialValues.phone}</p>
    </div>
  ),
}));

import ProfilePage from "@/app/profile/page";

describe("ProfilePage", () => {
  it("renders profile summary, stats, verification note, and form defaults", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getProfileDashboard.mockResolvedValue({
      unreadNotifications: 3,
      unreadConversations: 2,
      user: {
        id: "user-1",
        name: "张同学",
        schoolName: "示例大学",
        bio: "负责教材整理和答疑。",
        verificationStatus: "REJECTED",
        college: "计算机学院",
        grade: "2023级",
        phone: "13800000000",
        avatarUrl: "/uploads/avatar.jpg",
        creditScore: 98,
        positiveReviewRate: 0.94,
        completedOrdersCount: 12,
        lastLoginAt: new Date("2026-07-17T10:00:00.000Z"),
        verification: {
          reviewNote: "请补充更清晰的学生证照片",
        },
        _count: {
          products: 4,
          createdErrandTasks: 2,
          serviceListings: 5,
          buyerOrders: 3,
          sellerOrders: 4,
        },
      },
    });

    render(await ProfilePage());

    expect(screen.getByRole("heading", { name: "张同学" })).toBeTruthy();
    expect(screen.getByText("示例大学")).toBeTruthy();
    expect(screen.getByText("负责教材整理和答疑。")).toBeTruthy();
    expect(screen.getByText("我的商品")).toBeTruthy();
    expect(screen.getByText("我的任务")).toBeTruthy();
    expect(screen.getByText("我的服务")).toBeTruthy();
    expect(screen.getByText("我的订单")).toBeTruthy();
    expect(screen.getByText("未读通知")).toBeTruthy();
    expect(screen.getByText("未读会话")).toBeTruthy();
    expect(screen.getByText("审核备注：请补充更清晰的学生证照片")).toBeTruthy();
    expect(screen.getByRole("link", { name: "前往认证页" }).getAttribute("href")).toBe(
      "/verification",
    );
    expect(screen.getByText("表单姓名 张同学")).toBeTruthy();
    expect(screen.getByText("表单学院 计算机学院")).toBeTruthy();
    expect(screen.getByText("表单年级 2023级")).toBeTruthy();
    expect(screen.getByText("表单手机号 13800000000")).toBeTruthy();
    expect(screen.getByText("表单姓名 张同学").parentElement?.getAttribute("data-action")).toBe(
      "matched",
    );
  });
});
