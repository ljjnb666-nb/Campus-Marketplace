import { describe, expect, it } from "vitest";

import {
  ORDER_MEETUP_LOCATION_SOURCE_LABELS,
  ORDER_MEETUP_STATUS_LABELS,
  orderMeetupLocationSourceLabel,
  orderMeetupStatusLabel,
} from "@/lib/meetups/order-meetup-labels";

/**
 * Phase 8D-02：中文状态体系单一映射合同（§12）——raw enum 禁止出现在
 * 用户界面，全部展示文案经本模块。
 */
describe("order-meetup-labels：中文状态单一映射", () => {
  it("ORDER_MEETUP_STATUS_LABELS 冻结映射（§12 原文一致）", () => {
    expect(ORDER_MEETUP_STATUS_LABELS).toEqual({
      PROPOSED: "待对方确认",
      CONFIRMED: "已确认见面",
      COMPLETED: "双方已到场",
      CANCELLED: "已取消",
      NO_SHOW_REPORTED: "已报告未到场",
    });
  });

  it("ORDER_MEETUP_LOCATION_SOURCE_LABELS 冻结映射", () => {
    expect(ORDER_MEETUP_LOCATION_SOURCE_LABELS).toEqual({
      MEETUP_POINT: "校内推荐见面点",
      CUSTOM: "自定义地点",
    });
  });

  it("helper 对未知值回退原值（防御性，不抛错）", () => {
    expect(orderMeetupStatusLabel("PROPOSED")).toBe("待对方确认");
    expect(orderMeetupStatusLabel("FUTURE_STATUS")).toBe("FUTURE_STATUS");
    expect(orderMeetupLocationSourceLabel("MEETUP_POINT")).toBe("校内推荐见面点");
    expect(orderMeetupLocationSourceLabel("UNKNOWN")).toBe("UNKNOWN");
  });
});
