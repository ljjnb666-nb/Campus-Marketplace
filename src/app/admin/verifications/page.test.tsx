import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAdmin, getVerificationReviewQueue, reviewVerification } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getVerificationReviewQueue: vi.fn(),
  reviewVerification: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  requireAdmin,
}));

vi.mock("@/repositories/admin-repository", () => ({
  getVerificationReviewQueue,
}));

vi.mock("@/actions/admin", () => ({
  reviewVerification,
}));

import AdminVerificationsPage from "@/app/admin/verifications/page";

afterEach(() => {
  cleanup();
});

describe("AdminVerificationsPage", () => {
  it("renders the empty state when there are no verification items", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getVerificationReviewQueue.mockResolvedValue([]);

    render(await AdminVerificationsPage());

    expect(screen.getByRole("heading", { name: "认证审核" })).toBeTruthy();
    expect(screen.getByText("当前没有待审核认证。")).toBeTruthy();
  });

  it("renders verification review details and actions", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getVerificationReviewQueue.mockResolvedValue([
      {
        id: "verification-1",
        userId: "user-1",
        schoolName: "示例大学",
        campusName: "主校区",
        studentIdLast4: "1234",
        studentCardImage: "/uploads/verification/card.jpg",
        reviewNote: "请补充更清晰照片",
        submittedAt: new Date("2026-07-18T08:00:00.000Z"),
        user: {
          name: "张同学",
          email: "student@example.com",
          campus: { name: "主校区" },
        },
      },
    ]);

    render(await AdminVerificationsPage());

    expect(screen.getByText("张同学")).toBeTruthy();
    expect(screen.getByText("邮箱：student@example.com")).toBeTruthy();
    expect(screen.getByText("学校：示例大学")).toBeTruthy();
    expect(screen.getAllByText("校区：主校区")).toHaveLength(1);
    expect(screen.getByText("当前用户校区：主校区")).toBeTruthy();
    expect(screen.getByText("学号后四位：1234")).toBeTruthy();
    expect(screen.getByText("上次备注：请补充更清晰照片")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看学生证材料" }).getAttribute("href")).toBe(
      "/uploads/verification/card.jpg",
    );
    expect(screen.getByDisplayValue("verification-1")).toBeTruthy();
    expect(screen.getByDisplayValue("user-1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "通过认证" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "驳回申请" })).toBeTruthy();
  });
});
