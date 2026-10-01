import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getOrderMeetupView, notFound } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getOrderMeetupView: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));

vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/meetups/order-meetup-query", () => ({ getOrderMeetupView }));

import OrderMeetupPage from "@/app/my/orders/[id]/meetup/page";
import type { OrderMeetupView } from "@/lib/meetups/order-meetup-query";

/**
 * Phase 8D-02：见面约定页面状态机 UX（§13 A-I）+ 中文状态体系（§12）。
 *
 * 冻结断言基线：用户可见文字绝不出现 raw enum（PROPOSED / CONFIRMED /
 * COMPLETED / CANCELLED / NO_SHOW_REPORTED / MEETUP_POINT / CUSTOM）；
 * 断言只针对用户可见文本（queryByText 不匹配 hidden input value）。
 */

const MIN = 60 * 1000;

function buildMeetup(overrides: Partial<OrderMeetupView["meetups"][number]>) {
  return {
    id: "meetup-1",
    status: "PROPOSED" as const,
    scheduledAt: new Date(Date.now() + 60 * MIN),
    locationTextSnapshot: "图书馆北门台阶",
    locationSource: "MEETUP_POINT" as const,
    proposedById: "user-1",
    confirmedById: null,
    cancelledAt: null,
    buyerArrivedAt: null,
    sellerArrivedAt: null,
    noShowReportedById: null,
    triggeredDisputeId: null,
    createdAt: new Date(Date.now() - 5 * MIN),
    ...overrides,
  };
}

function buildView(overrides: Partial<OrderMeetupView> = {}): OrderMeetupView {
  return {
    order: {
      id: "order-1",
      orderNo: "PO202610010001",
      type: "PRODUCT",
      status: "ACCEPTED",
      amount: "10.00",
      title: "二手自行车",
      counterpartyName: "对方同学",
      initialMeetingLocation: "东门",
    },
    viewerRole: "buyer",
    meetups: [],
    meetupPointOptions: [
      { id: "point-1", name: "图书馆北门", locationText: "图书馆北门台阶" },
    ],
    ...overrides,
  };
}

async function renderPage(view: OrderMeetupView | null, viewerId = "user-1") {
  requireUser.mockResolvedValue({ id: viewerId });
  getOrderMeetupView.mockResolvedValue(view);
  return render(await OrderMeetupPage({ params: Promise.resolve({ id: "order-1" }) }));
}

const RAW_ENUMS = [
  "PROPOSED",
  "CONFIRMED",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW_REPORTED",
  "MEETUP_POINT",
  "CUSTOM",
] as const;

function expectNoRawEnumVisible() {
  for (const raw of RAW_ENUMS) {
    expect(screen.queryByText(raw), `raw enum "${raw}" 不得作为用户可见文字`).toBeNull();
  }
}

/** 状态徽标与历史列表可能同现同一中文标签：以"至少出现一次"断言 */
function expectVisible(text: string | RegExp) {
  expect(screen.getAllByText(text).length).toBeGreaterThan(0);
}

afterEach(() => {
  cleanup();
});

describe("OrderMeetupPage：状态机 UX（§13）", () => {
  it("A：无 active meetup + Order ACCEPTED → 双方可发起（表单 + 时间 + 地点来源）", async () => {
    await renderPage(buildView());

    expect(screen.getByRole("button", { name: "发起见面约定" })).toBeTruthy();
    expect(screen.getByLabelText(/约定时间/)).toBeTruthy();
    expect(screen.getByText("校内推荐见面点")).toBeTruthy();
    expect(screen.getByText("自定义地点")).toBeTruthy();
    expectNoRawEnumVisible();
  });

  it("A-ERRAND：type authority——查询投影 null → notFound（不泄露任何内容）", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getOrderMeetupView.mockResolvedValue(null);

    await expect(
      OrderMeetupPage({ params: Promise.resolve({ id: "order-1" }) }),
    ).rejects.toThrow("notFound");
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("B：PROPOSED proposer 视角 → 待对方确认 + 仅可取消", async () => {
    await renderPage(
      buildView({ meetups: [buildMeetup({ status: "PROPOSED", proposedById: "user-1" })] }),
    );

    expectVisible("待对方确认");
    expect(screen.getByText(/等待对方确认/)).toBeTruthy();
    expect(screen.getByText(/发起人：你/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消约定" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "确认约定" })).toBeNull();
    expectNoRawEnumVisible();
  });

  it("B：PROPOSED counterparty 视角 → 确认约定 + 取消约定", async () => {
    await renderPage(
      buildView({
        viewerRole: "seller",
        meetups: [buildMeetup({ status: "PROPOSED", proposedById: "user-1" })],
      }),
      "user-2",
    );

    expect(screen.getByText(/对方发起了见面约定/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认约定" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消约定" })).toBeTruthy();
    expectNoRawEnumVisible();
  });

  it("C：CONFIRMED 未到时间 → 已确认见面 + 可取消，不显示我已到达", async () => {
    await renderPage(
      buildView({
        meetups: [
          buildMeetup({
            status: "CONFIRMED",
            confirmedById: "user-2",
            scheduledAt: new Date(Date.now() + 60 * MIN),
          }),
        ],
      }),
    );

    expectVisible("已确认见面");
    expect(screen.getByRole("button", { name: "取消约定" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "我已到达" })).toBeNull();
    expectNoRawEnumVisible();
  });

  it("D：CONFIRMED 已到时间 → 我已到达（self check-in），无可取消", async () => {
    await renderPage(
      buildView({
        meetups: [
          buildMeetup({
            status: "CONFIRMED",
            confirmedById: "user-2",
            scheduledAt: new Date(Date.now() - 5 * MIN),
          }),
        ],
      }),
    );

    expect(screen.getByRole("button", { name: "我已到达" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取消约定" })).toBeNull();
    expectNoRawEnumVisible();
  });

  it("E：自己已到 + grace 内 → 等待对方到场 + 15 分钟提示，无未到场按钮", async () => {
    await renderPage(
      buildView({
        meetups: [
          buildMeetup({
            status: "CONFIRMED",
            confirmedById: "user-2",
            scheduledAt: new Date(Date.now() - 10 * MIN),
            buyerArrivedAt: new Date(Date.now() - 9 * MIN),
          }),
        ],
      }),
    );

    expect(screen.getByText(/你已到达，等待对方到场/)).toBeTruthy();
    expect(screen.getByText(/约定时间后 15 分钟才可报告未到场/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "报告对方未到场" })).toBeNull();
    expectNoRawEnumVisible();
  });

  it("F：自己已到 + grace 已结束 → 报告对方未到场", async () => {
    await renderPage(
      buildView({
        meetups: [
          buildMeetup({
            status: "CONFIRMED",
            confirmedById: "user-2",
            scheduledAt: new Date(Date.now() - 20 * MIN),
            buyerArrivedAt: new Date(Date.now() - 19 * MIN),
          }),
        ],
      }),
    );

    expect(screen.getByRole("button", { name: "报告对方未到场" })).toBeTruthy();
    expectNoRawEnumVisible();
  });

  it("G：双方已到 → 双方已到场 + 明确不等于订单完成", async () => {
    await renderPage(
      buildView({
        meetups: [
          buildMeetup({
            status: "COMPLETED",
            confirmedById: "user-2",
            scheduledAt: new Date(Date.now() - 30 * MIN),
            buyerArrivedAt: new Date(Date.now() - 25 * MIN),
            sellerArrivedAt: new Date(Date.now() - 20 * MIN),
          }),
        ],
      }),
    );

    expectVisible("双方已到场");
    expect(screen.getByText(/见面约定完成不等于订单完成/)).toBeTruthy();
    expectNoRawEnumVisible();
  });

  it("H：CANCELLED + Order ACCEPTED → 已取消说明 + 可重新发起", async () => {
    await renderPage(
      buildView({
        meetups: [
          buildMeetup({
            status: "CANCELLED",
            cancelledAt: new Date(Date.now() - 2 * MIN),
          }),
        ],
      }),
    );

    expect(screen.getByText("该次见面约定已取消，历史记录保留如下。")).toBeTruthy();
    expectVisible("已取消");
    // 原 snapshot 仍展示（地点 + 时间）
    expect(screen.getByText(/原约定地点：图书馆北门台阶/)).toBeTruthy();
    // ACCEPTED → 可重新发起
    expect(screen.getByRole("button", { name: "发起见面约定" })).toBeTruthy();
    expectNoRawEnumVisible();
  });

  it("I：NO_SHOW_REPORTED → 已报告未到场 + 订单已进入纠纷处理（allegation 语义）", async () => {
    await renderPage(
      buildView({
        order: { ...buildView().order, status: "IN_DISPUTE" },
        meetups: [
          buildMeetup({
            status: "NO_SHOW_REPORTED",
            noShowReportedById: "user-1",
            triggeredDisputeId: "dispute-1",
            scheduledAt: new Date(Date.now() - 40 * MIN),
            buyerArrivedAt: new Date(Date.now() - 35 * MIN),
          }),
        ],
      }),
    );

    expectVisible("已报告未到场");
    expectVisible(/订单已进入纠纷处理/);
    // allegation ≠ 判责语义必须可见
    expect(screen.getByText(/不代表已作出责任判定/)).toBeTruthy();
    // 不泄漏内部 dispute id / provenance 结构
    expect(screen.queryByText(/dispute-1/)).toBeNull();
    expectNoRawEnumVisible();
  });

  it("IN_DISPUTE 订单横幅 + 已有历史时入口信息仍完整（no-show 后可回看）", async () => {
    await renderPage(
      buildView({
        order: { ...buildView().order, status: "IN_DISPUTE" },
        meetups: [
          buildMeetup({
            status: "NO_SHOW_REPORTED",
            noShowReportedById: "user-1",
          }),
        ],
      }),
    );

    expect(screen.getByText("订单已进入纠纷处理，平台将按纠纷流程跟进。")).toBeTruthy();
    // 非 ACCEPTED 且有 active（NO_SHOW_REPORTED 属 active set）→ 不出现发起表单
    expect(screen.queryByRole("button", { name: "发起见面约定" })).toBeNull();
  });

  it("非 ACCEPTED 且无 active meetup（如 COMPLETED 订单）→ 不出现发起表单", async () => {
    await renderPage(
      buildView({
        order: { ...buildView().order, status: "COMPLETED" },
        meetups: [
          buildMeetup({ status: "CANCELLED", cancelledAt: new Date() }),
        ],
      }),
    );

    expect(screen.queryByRole("button", { name: "发起见面约定" })).toBeNull();
    expect(screen.getByText("该次见面约定已取消，历史记录保留如下。")).toBeTruthy();
  });

  it("历史列表：snapshot 地点 + 中文来源标签（快照权威，非 point 当前值）", async () => {
    await renderPage(
      buildView({
        meetups: [
          buildMeetup({
            status: "CANCELLED",
            locationSource: "MEETUP_POINT",
            locationTextSnapshot: "旧图书馆台阶（点已删除后的快照）",
            cancelledAt: new Date(),
          }),
          buildMeetup({
            id: "meetup-2",
            status: "PROPOSED",
            locationSource: "CUSTOM",
            locationTextSnapshot: "东门快递柜旁",
          }),
        ],
      }),
    );

    expect(screen.getByText(/旧图书馆台阶（点已删除后的快照）/)).toBeTruthy();
    // 当前约定卡 + 历史列表可能同现同一地点 snapshot → 至少一次
    expectVisible(/东门快递柜旁/);
    // 中文来源标签
    expectVisible(/校内推荐见面点/);
    expectNoRawEnumVisible();
  });
});
