import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  proposeOrderMeetupTx,
  confirmOrderMeetupTx,
  cancelOrderMeetupTx,
  markOrderMeetupArrivalTx,
  reportOrderMeetupNoShowTx,
  withTransaction,
  revalidateOrderMeetupViews,
  requireUser,
  loggerError,
} = vi.hoisted(() => ({
  proposeOrderMeetupTx: vi.fn(),
  confirmOrderMeetupTx: vi.fn(),
  cancelOrderMeetupTx: vi.fn(),
  markOrderMeetupArrivalTx: vi.fn(),
  reportOrderMeetupNoShowTx: vi.fn(),
  withTransaction: vi.fn(),
  revalidateOrderMeetupViews: vi.fn(),
  requireUser: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/meetups/order-meetup-service", () => ({
  proposeOrderMeetupTx,
  confirmOrderMeetupTx,
  cancelOrderMeetupTx,
  markOrderMeetupArrivalTx,
  reportOrderMeetupNoShowTx,
}));
vi.mock("@/lib/prisma", () => ({ withTransaction }));
vi.mock("@/lib/revalidate", () => ({ revalidateOrderMeetupViews }));
vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/logger", () => ({ logger: { error: loggerError, warn: vi.fn(), info: vi.fn() } }));

import {
  cancelOrderMeetupAction,
  confirmOrderMeetupAction,
  markOrderMeetupArrivalAction,
  proposeOrderMeetupAction,
  reportOrderMeetupNoShowAction,
} from "@/actions/order-meetup";
import { type MeetupErrorCode } from "@/lib/meetups/errors";

/**
 * Phase 8D-02：Meetup 用户入口薄适配层合同（validate → requireUser →
 * withTransaction → canonical 8D-01 Tx service → revalidate → safe response）。
 *
 * 指令 §10：participant / type / status / campus / 时间窗 / 地点裁决全部在
 * canonical 服务锁内 fresh revalidate——action 层零域判断复制；actor 身份
 * 恒来自 session，FormData 身份字段完全忽略。
 */

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    fd.set(k, v);
  }
  return fd;
}

beforeEach(() => {
  for (const fn of [
    proposeOrderMeetupTx,
    confirmOrderMeetupTx,
    cancelOrderMeetupTx,
    markOrderMeetupArrivalTx,
    reportOrderMeetupNoShowTx,
    withTransaction,
    revalidateOrderMeetupViews,
    requireUser,
    loggerError,
  ]) {
    fn.mockReset();
  }
  requireUser.mockResolvedValue({ id: "user-1" });
  withTransaction.mockImplementation(async (fn: (tx: symbol) => Promise<unknown>) => fn(Symbol("tx")));
});

describe("order-meetup actions：actor 身份来自 session only（ACTION-01..05）", () => {
  it("ACTION-01：propose——客户端伪造 actorId/userId/proposerId 被忽略，实际 actor = requireUser；地点来源按 choice 精确映射", async () => {
    proposeOrderMeetupTx.mockResolvedValue({
      success: true,
      meetupId: "meetup-1",
      campusId: "campus-1",
      locationTextSnapshot: "图书馆北门",
      status: "PROPOSED",
    });

    // 恶意客户端：塞入伪造身份字段（validator schema 不设这些字段，
    // action 层完全不读取）
    const fd = formData({
      orderId: "order-1",
      scheduledAt: "2026-10-05T14:30",
      locationSource: "MEETUP_POINT",
      meetupPointId: "point-1",
      actorId: "attacker-1",
      userId: "attacker-1",
      proposerId: "attacker-1",
      buyerId: "attacker-1",
      sellerId: "attacker-1",
    });
    const result = await proposeOrderMeetupAction({ success: false, message: "" }, fd);

    expect(result).toEqual({ success: true, message: "见面约定已发起，等待对方确认" });
    expect(proposeOrderMeetupTx).toHaveBeenCalledTimes(1);
    const [tx, input] = proposeOrderMeetupTx.mock.calls[0];
    // actor 唯一来源 = session user；伪造身份字段不进入 canonical input
    expect(input.proposerId).toBe("user-1");
    // TIME-04：datetime-local 文本经 canonical Asia/Shanghai 解释为绝对
    // instant（2026-10-05T14:30 campus wall-clock ≡ 06:30Z），绝不依赖
    // server local timezone
    expect(input).toEqual({
      orderId: "order-1",
      proposerId: "user-1",
      scheduledAt: new Date("2026-10-05T06:30:00.000Z"),
      meetupPointId: "point-1",
      locationText: null,
    });
    expect((input.scheduledAt as Date).toISOString()).toBe("2026-10-05T06:30:00.000Z");
    expect(tx).toBeDefined();
    expect(revalidateOrderMeetupViews).toHaveBeenCalledWith("order-1");
  });

  it("ACTION-01b：propose CUSTOM 来源——只传 locationText，meetupPointId 恒 null", async () => {
    proposeOrderMeetupTx.mockResolvedValue({
      success: true,
      meetupId: "meetup-1",
      campusId: "campus-1",
      locationTextSnapshot: "东门快递柜旁",
      status: "PROPOSED",
    });

    await proposeOrderMeetupAction(
      { success: false, message: "" },
      formData({
        orderId: "order-1",
        scheduledAt: "2026-10-05T14:30",
        locationSource: "CUSTOM",
        locationText: "东门快递柜旁",
      }),
    );

    expect(proposeOrderMeetupTx.mock.calls[0][1]).toMatchObject({
      meetupPointId: null,
      locationText: "东门快递柜旁",
    });
  });

  it("ACTION-02：confirm——confirmerId = 当前 session user", async () => {
    confirmOrderMeetupTx.mockResolvedValue({ success: true, status: "CONFIRMED" });

    const result = await confirmOrderMeetupAction(
      { success: false, message: "" },
      formData({
        orderId: "order-1",
        meetupId: "meetup-1",
        confirmerId: "attacker-1",
        userId: "attacker-1",
      }),
    );

    expect(result.success).toBe(true);
    expect(confirmOrderMeetupTx.mock.calls[0][1]).toEqual({
      orderId: "order-1",
      meetupId: "meetup-1",
      confirmerId: "user-1",
    });
  });

  it("ACTION-03：cancel——actorId = 当前 session user", async () => {
    cancelOrderMeetupTx.mockResolvedValue({ success: true, status: "CANCELLED" });

    const result = await cancelOrderMeetupAction(
      { success: false, message: "" },
      formData({
        orderId: "order-1",
        meetupId: "meetup-1",
        actorId: "attacker-1",
        userId: "attacker-1",
      }),
    );

    expect(result.success).toBe(true);
    expect(cancelOrderMeetupTx.mock.calls[0][1]).toEqual({
      orderId: "order-1",
      meetupId: "meetup-1",
      actorId: "user-1",
    });
  });

  it("ACTION-04：arrival——input 不存在任何 target 字段，恒 self arrival", async () => {
    markOrderMeetupArrivalTx.mockResolvedValue({
      success: true,
      status: "COMPLETED",
      alreadyArrived: false,
    });

    const result = await markOrderMeetupArrivalAction(
      { success: false, message: "" },
      formData({
        orderId: "order-1",
        meetupId: "meetup-1",
        targetUserId: "attacker-1",
        actorId: "attacker-1",
        userId: "attacker-1",
      }),
    );

    expect(result.success).toBe(true);
    const input = markOrderMeetupArrivalTx.mock.calls[0][1];
    expect(input).toEqual({ orderId: "order-1", meetupId: "meetup-1", actorId: "user-1" });
    expect(Object.keys(input)).not.toContain("targetUserId");
  });

  it("ACTION-04b：arrival 幂等（alreadyArrived）→ 安全提示文案", async () => {
    markOrderMeetupArrivalTx.mockResolvedValue({
      success: true,
      status: "CONFIRMED",
      alreadyArrived: true,
    });

    const result = await markOrderMeetupArrivalAction(
      { success: false, message: "" },
      formData({ orderId: "order-1", meetupId: "meetup-1" }),
    );

    expect(result).toEqual({ success: true, message: "你已登记过到场" });
  });

  it("ACTION-05：no-show——reporterId = 当前 session user；targetUserId 字段不进入 canonical input", async () => {
    reportOrderMeetupNoShowTx.mockResolvedValue({
      success: true,
      disputeId: "dispute-1",
      status: "NO_SHOW_REPORTED",
    });

    const result = await reportOrderMeetupNoShowAction(
      { success: false, message: "" },
      formData({
        orderId: "order-1",
        meetupId: "meetup-1",
        reporterId: "attacker-1",
        targetUserId: "victim-1",
        userId: "attacker-1",
      }),
    );

    expect(result).toEqual({
      success: true,
      message: "未到场报告已提交，订单已进入纠纷处理",
    });
    expect(reportOrderMeetupNoShowTx.mock.calls[0][1]).toEqual({
      orderId: "order-1",
      meetupId: "meetup-1",
      reporterId: "user-1",
    });
  });
});

describe("order-meetup actions：错误映射（ACTION-06 / ACTION-07）", () => {
  it("ACTION-06：领域 { error: code } → errors.ts 单一 SAFE 中文映射，零 revalidate", async () => {
    const cases: Array<{ code: MeetupErrorCode; expected: string }> = [
      { code: "MEETUP_ACTIVE_EXISTS", expected: "该订单已有进行中的见面约定" },
      { code: "MEETUP_TIME_WINDOW", expected: "不在允许的时间窗口内" },
      { code: "MEETUP_INVALID_TRANSITION", expected: "当前状态不允许此操作" },
      { code: "MEETUP_FORBIDDEN", expected: "没有权限操作该见面约定" },
      { code: "MEETUP_POINT_INVALID", expected: "见面点不可用" },
      { code: "MEETUP_LOCATION_INVALID", expected: "见面地点无效" },
      { code: "MEETUP_NOT_FOUND", expected: "见面约定不存在" },
    ];

    for (const { code, expected } of cases) {
      proposeOrderMeetupTx.mockResolvedValue({ error: code });
      const result = await proposeOrderMeetupAction(
        { success: false, message: "" },
        formData({
          orderId: "order-1",
          scheduledAt: "2026-10-05T14:30",
          locationSource: "CUSTOM",
          locationText: "东门快递柜旁",
        }),
      );
      expect(result).toEqual({ success: false, message: expected });
      // raw enum 不出现在用户文案
      expect(result.message).not.toContain(code);
    }

    // confirm / cancel / arrival / no-show 同一映射函数（抽验）
    confirmOrderMeetupTx.mockResolvedValue({ error: "MEETUP_TIME_WINDOW" });
    expect(
      (await confirmOrderMeetupAction({ success: false, message: "" }, formData({ orderId: "o", meetupId: "m" })))
        .message,
    ).toBe("不在允许的时间窗口内");

    cancelOrderMeetupTx.mockResolvedValue({ error: "MEETUP_INVALID_TRANSITION" });
    expect(
      (await cancelOrderMeetupAction({ success: false, message: "" }, formData({ orderId: "o", meetupId: "m" })))
        .message,
    ).toBe("当前状态不允许此操作");

    markOrderMeetupArrivalTx.mockResolvedValue({ error: "MEETUP_TIME_WINDOW" });
    expect(
      (
        await markOrderMeetupArrivalAction({ success: false, message: "" }, formData({ orderId: "o", meetupId: "m" }))
      ).message,
    ).toBe("不在允许的时间窗口内");

    reportOrderMeetupNoShowTx.mockResolvedValue({ error: "MEETUP_INVALID_TRANSITION" });
    expect(
      (
        await reportOrderMeetupNoShowAction({ success: false, message: "" }, formData({ orderId: "o", meetupId: "m" }))
      ).message,
    ).toBe("当前状态不允许此操作");

    expect(revalidateOrderMeetupViews).not.toHaveBeenCalled();
  });

  it("ACTION-07：unknown exception → logger 记录 + 统一兜底文案（raw error 不回浏览器）", async () => {
    proposeOrderMeetupTx.mockRejectedValue(new Error("P9999 raw prisma boom"));

    const result = await proposeOrderMeetupAction(
      { success: false, message: "" },
      formData({
        orderId: "order-1",
        scheduledAt: "2026-10-05T14:30",
        locationSource: "CUSTOM",
        locationText: "东门快递柜旁",
      }),
    );

    expect(result).toEqual({ success: false, message: "操作失败，请稍后重试" });
    expect(result.message).not.toContain("P9999");
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(revalidateOrderMeetupViews).not.toHaveBeenCalled();

    reportOrderMeetupNoShowTx.mockRejectedValue(new Error("unexpected domain crash"));
    const noShowResult = await reportOrderMeetupNoShowAction(
      { success: false, message: "" },
      formData({ orderId: "order-1", meetupId: "meetup-1" }),
    );
    expect(noShowResult).toEqual({ success: false, message: "操作失败，请稍后重试" });
    expect(loggerError).toHaveBeenCalledTimes(2);
  });
});

describe("order-meetup actions：validator DENY（ACTION-08）", () => {
  it("ACTION-08：invalid Date / invalid location / 缺字段 → 参数错误，canonical 服务零调用", async () => {
    const invalidPayloads: Array<Record<string, string>> = [
      // invalid Date
      { orderId: "order-1", scheduledAt: "not-a-date", locationSource: "CUSTOM", locationText: "东门快递柜旁" },
      // 越界字段 / offset 伪装 datetime-local（RB01 TIME-02）
      { orderId: "order-1", scheduledAt: "2026-99-99T25:99", locationSource: "CUSTOM", locationText: "东门快递柜旁" },
      { orderId: "order-1", scheduledAt: "2026-10-05T14:30+08:00", locationSource: "CUSTOM", locationText: "东门快递柜旁" },
      { orderId: "order-1", scheduledAt: "2026-02-30T10:00", locationSource: "CUSTOM", locationText: "东门快递柜旁" },
      // 缺 scheduledAt
      { orderId: "order-1", scheduledAt: "", locationSource: "CUSTOM", locationText: "东门快递柜旁" },
      // invalid location（CUSTOM 1 个字）
      { orderId: "order-1", scheduledAt: "2026-10-05T14:30", locationSource: "CUSTOM", locationText: "门" },
      // invalid location（超长）
      {
        orderId: "order-1",
        scheduledAt: "2026-10-05T14:30",
        locationSource: "CUSTOM",
        locationText: "地".repeat(81),
      },
      // MEETUP_POINT 缺 meetupPointId
      { orderId: "order-1", scheduledAt: "2026-10-05T14:30", locationSource: "MEETUP_POINT" },
      // 双通道同时提交
      {
        orderId: "order-1",
        scheduledAt: "2026-10-05T14:30",
        locationSource: "MEETUP_POINT",
        meetupPointId: "point-1",
        locationText: "恶意覆盖",
      },
      // 缺 orderId
      { scheduledAt: "2026-10-05T14:30", locationSource: "CUSTOM", locationText: "东门快递柜旁" },
      // 非法 locationSource
      { orderId: "order-1", scheduledAt: "2026-10-05T14:30", locationSource: "GPS" },
      // mutation：缺 meetupId
      { orderId: "order-1" },
    ];

    for (const payload of invalidPayloads) {
      const result = await proposeOrderMeetupAction({ success: false, message: "" }, formData(payload));
      expect(result.success).toBe(false);
      expect(result.message).toBeTruthy();
      const mutationResult = await confirmOrderMeetupAction({ success: false, message: "" }, formData(payload));
      expect(mutationResult.success).toBe(false);
    }

    expect(proposeOrderMeetupTx).not.toHaveBeenCalled();
    expect(confirmOrderMeetupTx).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
    expect(revalidateOrderMeetupViews).not.toHaveBeenCalled();
  });
});
