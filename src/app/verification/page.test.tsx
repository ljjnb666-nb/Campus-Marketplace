import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { requireUser, getProfileDashboard, submitVerification } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getProfileDashboard: vi.fn(),
  submitVerification: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/user-repository", () => ({
  getProfileDashboard,
}));

vi.mock("@/actions/user", () => ({
  submitVerification,
}));

vi.mock("@/components/profile/verification-form", () => ({
  VerificationForm: ({
    action,
    initialValues,
  }: {
    action: unknown;
    initialValues: {
      schoolName: string;
      campusName: string;
      studentIdLast4?: string | null;
      studentCardImage?: string | null;
    };
  }) => (
    <div data-action={action === submitVerification ? "matched" : "unmatched"}>
      <p>学校 {initialValues.schoolName}</p>
      <p>校区 {initialValues.campusName}</p>
      <p>学号后四位 {initialValues.studentIdLast4}</p>
      <p>证件图 {initialValues.studentCardImage}</p>
    </div>
  ),
}));

import VerificationPage from "@/app/verification/page";

describe("VerificationPage", () => {
  it("renders verification status, review note, and the form defaults", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getProfileDashboard.mockResolvedValue({
      user: {
        verificationStatus: "REJECTED",
        schoolName: "示例大学",
        campus: { name: "主校区" },
        studentIdLast4: "1234",
        verification: {
          schoolName: "示例大学",
          campusName: "主校区",
          studentIdLast4: "1234",
          studentCardImage: "/uploads/verification/card.jpg",
          submittedAt: new Date("2026-07-17T10:00:00.000Z"),
          reviewedAt: new Date("2026-07-18T09:00:00.000Z"),
          reviewNote: "请重新上传更清晰的学生证照片",
        },
      },
    });

    render(await VerificationPage());

    expect(screen.getByRole("heading", { name: "校园认证" })).toBeTruthy();
    expect(screen.getByText("未通过")).toBeTruthy();
    expect(screen.getByText("学校：示例大学")).toBeTruthy();
    expect(screen.getByText("校区：主校区")).toBeTruthy();
    expect(screen.getByText("学号后四位：1234")).toBeTruthy();
    expect(screen.getByText("审核备注：请重新上传更清晰的学生证照片")).toBeTruthy();
    expect(screen.getByText("学校 示例大学")).toBeTruthy();
    expect(screen.getByText("校区 主校区")).toBeTruthy();
    expect(screen.getByText("学号后四位 1234")).toBeTruthy();
    expect(screen.getByText("证件图 /uploads/verification/card.jpg")).toBeTruthy();
    expect(screen.getByText("学校 示例大学").parentElement?.getAttribute("data-action")).toBe(
      "matched",
    );
    expect(screen.getByText(/提交说明：/)).toBeTruthy();
    expect(screen.getByText(/学生证材料目前通过图片链接提交/)).toBeTruthy();
  });

  it("shows placeholders for users without any verification record", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getProfileDashboard.mockResolvedValue({
      user: {
        verificationStatus: "UNVERIFIED",
        schoolName: null,
        campus: { name: "主校区" },
        studentIdLast4: null,
        verification: null,
      },
    });

    render(await VerificationPage());

    expect(screen.getByText("未认证")).toBeTruthy();
    expect(screen.getAllByText("校区：主校区").length).toBeGreaterThan(0);
    expect(screen.getByText("学号后四位：未填写")).toBeTruthy();
    expect(screen.getByText("提交时间：暂无")).toBeTruthy();
    expect(screen.getByText("审核时间：暂无")).toBeTruthy();
  });
});
