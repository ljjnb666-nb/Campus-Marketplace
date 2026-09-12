import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAppealReviewer, loadAuthorizedAppealDetail, notFound } = vi.hoisted(() => ({
  requireAppealReviewer: vi.fn(),
  loadAuthorizedAppealDetail: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/lib/appeals/reviewer-access", () => ({
  requireAppealReviewer,
}));

vi.mock("@/lib/appeals/review-queue", () => ({
  loadAuthorizedAppealDetail,
}));

vi.mock("@/actions/governance-appeals", () => ({
  beginGovernanceAppealReview: vi.fn(),
  decideGovernanceAppeal: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound,
}));

import GovernanceAppealDetailPage from "@/app/governance/appeals/[id]/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockReviewer() {
  requireAppealReviewer.mockResolvedValue({
    user: { id: "viewer-1", email: "r@x", name: "审核员", role: "STUDENT" },
    context: { userId: "viewer-1", accountActive: true, activeCampusIds: [], grants: [] },
    access: { global: false, campusIds: ["campus-1"] },
  });
}

function okDetail(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    detail: {
      id: "appeal-1",
      status: "IN_REVIEW",
      statement: "申诉陈述内容",
      createdAt: new Date("2026-09-12T08:00:00.000Z").toISOString(),
      decisionReasonCode: null,
      enforcement: {
        type: "MEMBERSHIP_SUSPEND",
        createdAt: new Date("2026-09-11T08:00:00.000Z").toISOString(),
        reasonCode: "POLICY_VIOLATION",
        previousState: "CAMPUS_MEMBERSHIP:ACTIVE",
        scopeKind: "CAMPUS",
        campusName: "主校区",
      },
      appellantName: "申诉人甲",
      selfReview: false,
    },
    capabilities: { canBeginReview: false, canUphold: true, canGrant: false },
    ...overrides,
  };
}

async function renderDetail(id = "appeal-1") {
  render(await GovernanceAppealDetailPage({ params: Promise.resolve({ id }) }));
}

describe("GovernanceAppealDetailPage（申诉详情）", () => {
  it("渲染 statement/执法上下文/capability 提示（canGrant=false → GRANTED 不可用）", async () => {
    mockReviewer();
    loadAuthorizedAppealDetail.mockResolvedValue(okDetail());

    await renderDetail();

    expect(screen.getByRole("heading", { name: "申诉详情" })).toBeTruthy();
    expect(screen.getByText("申诉陈述内容")).toBeTruthy();
    expect(screen.getByText("申诉人：申诉人甲")).toBeTruthy();
    expect(screen.getByText("处罚类型：成员身份停用")).toBeTruthy();
    expect(screen.getByText("作用范围：校区：主校区")).toBeTruthy();
    expect(screen.getByText("处罚原因：违反平台规则")).toBeTruthy();
    // W1：IN_REVIEW 终局控件 + 恢复权缺失提示 + GRANTED 禁用
    expect(screen.getByRole("button", { name: "维持处罚" })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "通过申诉" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText(/你可以维持或驳回该申诉/)).toBeTruthy();
    // 禁披露面不出现在 DOM
    expect(screen.queryByText("E2E@example.com")).toBeNull();
  });

  it("selfReview 警示（reviewer==原执法 actor，非阻断）", async () => {
    mockReviewer();
    loadAuthorizedAppealDetail.mockResolvedValue(
      okDetail({
        detail: {
          id: "appeal-1",
          status: "IN_REVIEW",
          statement: "申诉陈述内容",
          createdAt: new Date("2026-09-12T08:00:00.000Z").toISOString(),
          decisionReasonCode: null,
          enforcement: {
            type: "MEMBERSHIP_SUSPEND",
            createdAt: new Date("2026-09-11T08:00:00.000Z").toISOString(),
            reasonCode: "POLICY_VIOLATION",
            previousState: "CAMPUS_MEMBERSHIP:ACTIVE",
            scopeKind: "CAMPUS",
            campusName: "主校区",
          },
          appellantName: "申诉人甲",
          selfReview: true,
        },
      }),
    );

    await renderDetail();

    expect(screen.getByRole("note")).toHaveTextContent(
      "你是该处罚的原执行者，本次决定将记录为 self-review",
    );
  });

  it("SUBMITTED 态仅呈现「开始审核」（W1）", async () => {
    mockReviewer();
    loadAuthorizedAppealDetail.mockResolvedValue(
      okDetail({
        detail: {
          id: "appeal-1",
          status: "SUBMITTED",
          statement: "申诉陈述内容",
          createdAt: new Date("2026-09-12T08:00:00.000Z").toISOString(),
          decisionReasonCode: null,
          enforcement: {
            type: "MEMBERSHIP_SUSPEND",
            createdAt: new Date("2026-09-11T08:00:00.000Z").toISOString(),
            reasonCode: "POLICY_VIOLATION",
            previousState: "CAMPUS_MEMBERSHIP:ACTIVE",
            scopeKind: "CAMPUS",
            campusName: "主校区",
          },
          appellantName: "申诉人甲",
          selfReview: false,
        },
        capabilities: { canBeginReview: true, canUphold: false, canGrant: false },
      }),
    );

    await renderDetail();

    expect(screen.getByRole("button", { name: "开始审核" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "维持处罚" })).toBeNull();
    expect(screen.queryByRole("button", { name: "通过申诉" })).toBeNull();
  });

  it("ok:false → notFound()（统一反枚举）", async () => {
    mockReviewer();
    loadAuthorizedAppealDetail.mockResolvedValue({ ok: false });

    await expect(renderDetail()).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });
});
