import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  getErrandDetail,
  createOrOpenErrandConversation,
  claimErrand,
  deleteErrand,
  createReport,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  getErrandDetail: vi.fn(),
  createOrOpenErrandConversation: vi.fn(),
  claimErrand: vi.fn(),
  deleteErrand: vi.fn(),
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

vi.mock("@/repositories/errand-repository", () => ({
  getErrandDetail,
}));

vi.mock("@/actions/conversation", () => ({
  createOrOpenErrandConversation,
}));

vi.mock("@/actions/errand", () => ({
  claimErrand,
  deleteErrand,
}));

vi.mock("@/actions/trust", () => ({
  createReport,
}));

vi.mock("@/components/errand/errand-card", () => ({
  ErrandCard: ({ title, reason }: { title: string; reason?: string }) => (
    <div>
      <p>{title}</p>
      {reason ? <p>{reason}</p> : null}
    </div>
  ),
}));

vi.mock("@/components/errand/errand-status-actions", () => ({
  ErrandStatusActions: ({
    errandId,
    actions,
  }: {
    errandId: string;
    actions: Array<{ label: string }>;
  }) => (
    <div>
      <p>任务状态 {errandId}</p>
      {actions.map((action) => (
        <p key={action.label}>{action.label}</p>
      ))}
    </div>
  ),
}));

vi.mock("@/components/trust/report-form", () => ({
  ReportForm: ({ targetType, errandTaskId }: { targetType: string; errandTaskId?: string }) => (
    <div>
      <p>举报类型 {targetType}</p>
      <p>举报任务 {errandTaskId}</p>
    </div>
  ),
}));

import ErrandDetailPage, { generateMetadata } from "@/app/errands/[id]/page";

afterEach(() => {
  cleanup();
});

function buildErrandDetail() {
  return {
    errand: {
      id: "errand-1",
      publisherId: "publisher-1",
      accepterId: null,
      title: "代取快递",
      reward: 6,
      description: "下午五点前送到宿舍。",
      pickupLocation: "快递站",
      deliveryLocation: "宿舍楼",
      deadline: new Date("2026-07-20T09:00:00.000Z"),
      contactNote: "到了先电话联系。",
      needsAdvancePay: true,
      advanceAmount: 20,
      status: "OPEN",
      category: { name: "代取快递" },
      campus: { schoolName: "示例大学", name: "主校区" },
      publisher: {
        id: "publisher-1",
        name: "王同学",
        schoolName: "示例大学",
        completedOrdersCount: 5,
        positiveReviewRate: 0.9,
        createdAt: new Date("2026-01-03T08:00:00.000Z"),
      },
      accepter: null,
    },
    relatedErrands: [
      {
        id: "errand-2",
        title: "代拿外卖",
        reward: 4,
        pickupLocation: "南门",
        deliveryLocation: "教学楼",
        publisher: { name: "李同学" },
        status: "OPEN",
        reason: "同校区同分类",
      },
    ],
  };
}

describe("ErrandDetailPage", () => {
  it("renders publisher controls and status actions", async () => {
    auth.mockResolvedValue({ user: { id: "publisher-1" } });
    getErrandDetail.mockResolvedValue(buildErrandDetail());

    render(
      await ErrandDetailPage({
        params: Promise.resolve({ id: "errand-1" }),
      }),
    );

    expect(screen.getByRole("heading", { name: "代取快递" })).toBeTruthy();
    expect(screen.getAllByText(/6/)[0]).toBeTruthy();
    expect(screen.getAllByText(/快递站/)[0]).toBeTruthy();
    expect(screen.getByRole("link", { name: "编辑任务" }).getAttribute("href")).toBe(
      "/errands/errand-1/edit",
    );
    expect(screen.getAllByDisplayValue("errand-1")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "删除任务" })).toBeTruthy();
    expect(screen.getByText("任务状态 errand-1")).toBeTruthy();
    expect(screen.getByText("取消任务")).toBeTruthy();
    expect(screen.getByText("代拿外卖")).toBeTruthy();
    expect(screen.getByText("同校区同分类")).toBeTruthy();
  });

  it("renders claim, contact, and report actions for other users", async () => {
    auth.mockResolvedValue({ user: { id: "runner-1" } });
    getErrandDetail.mockResolvedValue(buildErrandDetail());

    render(
      await ErrandDetailPage({
        params: Promise.resolve({ id: "errand-1" }),
      }),
    );

    expect(screen.getAllByDisplayValue("errand-1")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "立即接单" })[0]).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "私聊发布者" })[0]).toBeTruthy();
    expect(screen.getByTitle("举报此任务")).toBeTruthy();
  });
});

describe("ErrandDetailPage generateMetadata", () => {
  it("returns SEO metadata from the errand detail", async () => {
    getErrandDetail.mockResolvedValue(buildErrandDetail());

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: "errand-1" }),
    });

    expect(metadata.title).toBe("代取快递 - 校园集市");
    expect(metadata.description).toBe("下午五点前送到宿舍。");
    expect(metadata.openGraph?.title).toBe("代取快递 - 校园集市");
  });

  it("falls back to generic metadata when the errand is missing", async () => {
    getErrandDetail.mockRejectedValue(new Error("notFound"));

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: "missing-errand" }),
    });

    expect(metadata.title).toBe("跑腿任务详情 - 校园集市");
  });
});
