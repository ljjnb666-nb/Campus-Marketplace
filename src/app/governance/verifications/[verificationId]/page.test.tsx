import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireVerificationReviewer,
  loadAuthorizedVerificationDetail,
  reviewGovernanceVerification,
} = vi.hoisted(() => ({
  requireVerificationReviewer: vi.fn(),
  loadAuthorizedVerificationDetail: vi.fn(),
  reviewGovernanceVerification: vi.fn(),
}));

vi.mock("@/lib/campus/verification-review-access", () => ({
  requireVerificationReviewer,
}));

vi.mock("@/lib/campus/verification-review-query", () => ({
  loadAuthorizedVerificationDetail,
}));

vi.mock("@/actions/governance-verifications", () => ({
  reviewGovernanceVerification,
}));

vi.mock("@/components/shared/private-asset-viewer", () => ({
  PrivateAssetViewer: ({ label }: { label: string }) => <span>{label}</span>,
}));

import GovernanceVerificationDetailPage from "@/app/governance/verifications/[verificationId]/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockReviewer() {
  requireVerificationReviewer.mockResolvedValue({
    user: { id: "viewer-1", email: "r@x", name: "审核员", role: "STUDENT" },
    context: { userId: "viewer-1", accountActive: true, activeCampusIds: [], grants: [] },
    access: { global: false, campusIds: ["campus-1"] },
  });
}

function baseDetail(overrides: Record<string, unknown> = {}) {
  return {
    verificationId: "v-1",
    status: "PENDING",
    userDisplayName: "李同学",
    campusId: "campus-1",
    schoolName: "E2E 大学",
    campusName: "主校区",
    studentIdLast4: "4321",
    reviewNote: null,
    reasonCode: null,
    submittedAt: new Date("2026-09-18T08:00:00.000Z").toISOString(),
    reviewDueAt: new Date("2026-09-20T08:00:00.000Z").toISOString(),
    overdue: false,
    reviewedAt: null,
    reviewedByName: null,
    policyVersion: 1,
    studentCardImageRef: "asset:asset-1",
    evidenceUnavailable: false,
    ...overrides,
  };
}

async function renderDetail() {
  return render(
    await GovernanceVerificationDetailPage({ params: Promise.resolve({ verificationId: "v-1" }) }),
  );
}

describe("GovernanceVerificationDetailPage（认证详情，两阶段读）", () => {
  it("missing / 越权 / inactive membership 统一 notFound（无存在性 oracle）", async () => {
    mockReviewer();
    loadAuthorizedVerificationDetail.mockResolvedValue({ ok: false });

    await expect(renderDetail()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(loadAuthorizedVerificationDetail).toHaveBeenCalledWith({
      access: { global: false, campusIds: ["campus-1"] },
      verificationId: "v-1",
    });
  });

  it("渲染安全详情（学号后四位/policy 快照/证据查看入口/SLA 时限）", async () => {
    mockReviewer();
    loadAuthorizedVerificationDetail.mockResolvedValue({ ok: true, detail: baseDetail() });

    await renderDetail();

    expect(screen.getByRole("heading", { name: "认证详情" })).toBeTruthy();
    expect(screen.getByText(/申请人：李同学/)).toBeTruthy();
    expect(screen.getByText("学校：E2E 大学")).toBeTruthy();
    expect(screen.getByText("学号后四位：4321")).toBeTruthy();
    expect(screen.getByText("认证策略版本：v1")).toBeTruthy();
    expect(screen.getAllByText(/审核时限/).length).toBeGreaterThan(0);
    expect(screen.getByText("查看学生证材料")).toBeTruthy();
  });

  it("RB-01：legacy 证据行渲染非泄露不可用状态（绝不输出原始值）", async () => {
    mockReviewer();
    loadAuthorizedVerificationDetail.mockResolvedValue({
      ok: true,
      detail: baseDetail({
        studentCardImageRef: null,
        evidenceUnavailable: true,
      }),
    });

    const { container } = await renderDetail();

    expect(screen.getByText(/历史认证材料不可用/)).toBeTruthy();
    // 页面仅有合法的"返回队列"内链；不得出现指向原始证据值的链接
    for (const anchor of Array.from(container.querySelectorAll("a"))) {
      expect(anchor.getAttribute("href")).not.toContain("/uploads/");
      expect(anchor.getAttribute("href")).not.toContain("https://");
      expect(anchor.getAttribute("href")).not.toContain("javascript:");
    }
    expect(container.innerHTML).not.toContain("/uploads/");
    expect(container.innerHTML).not.toContain("https://");
  });

  it("PENDING → 通过/驳回可用、吊销禁用；overdue 徽标呈现", async () => {
    mockReviewer();
    loadAuthorizedVerificationDetail.mockResolvedValue({
      ok: true,
      detail: baseDetail({ overdue: true }),
    });

    await renderDetail();

    expect(screen.getByText("审核已超时")).toBeTruthy();
    expect(screen.getByRole("button", { name: "通过认证" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "驳回申请" })).toBeTruthy();
    const revoke = screen.getByRole("button", { name: "吊销认证" });
    expect(revoke).toHaveProperty("disabled", true);
  });

  it("VERIFIED → 吊销可用、通过/驳回禁用；上次审核记录呈现", async () => {
    mockReviewer();
    loadAuthorizedVerificationDetail.mockResolvedValue({
      ok: true,
      detail: baseDetail({
        status: "VERIFIED",
        reviewNote: "材料清晰",
        reasonCode: null,
        reviewedAt: new Date("2026-09-19T08:00:00.000Z").toISOString(),
        reviewedByName: "王审核",
      }),
    });

    await renderDetail();

    expect(screen.getByText("该用户已认证：可吊销认证（需其重新提交后才能恢复）。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "吊销认证" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "通过认证" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "驳回申请" })).toHaveProperty("disabled", true);
    expect(screen.getByText("上次审核人：王审核")).toBeTruthy();
    expect(screen.getByText("审核备注：材料清晰")).toBeTruthy();
  });
});
