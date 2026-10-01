/**
 * Phase 8D-02：Meetup 用户面的集中式中文状态映射。
 *
 * 冻结：用户界面禁止显示任何 raw enum / status code（PROPOSED /
 * CONFIRMED / NO_SHOW_REPORTED / MEETUP_POINT / CUSTOM 等机器值不得作为
 * 用户状态文字出现）；全部展示文案经本模块单一映射。
 *
 * 本文件保持零 server 依赖（不 import prisma / server-only 模块），
 * Server Component 与 Client Component 均可安全引用。
 */

export type OrderMeetupStatusValue =
  | "PROPOSED"
  | "CONFIRMED"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW_REPORTED";

export type OrderMeetupLocationSourceValue = "CUSTOM" | "MEETUP_POINT";

export const ORDER_MEETUP_STATUS_LABELS: Record<OrderMeetupStatusValue, string> = {
  PROPOSED: "待对方确认",
  CONFIRMED: "已确认见面",
  COMPLETED: "双方已到场",
  CANCELLED: "已取消",
  NO_SHOW_REPORTED: "已报告未到场",
};

export const ORDER_MEETUP_LOCATION_SOURCE_LABELS: Record<
  OrderMeetupLocationSourceValue,
  string
> = {
  MEETUP_POINT: "校内推荐见面点",
  CUSTOM: "自定义地点",
};

export function orderMeetupStatusLabel(status: string): string {
  return ORDER_MEETUP_STATUS_LABELS[status as OrderMeetupStatusValue] ?? status;
}

export function orderMeetupLocationSourceLabel(source: string): string {
  return (
    ORDER_MEETUP_LOCATION_SOURCE_LABELS[source as OrderMeetupLocationSourceValue] ?? source
  );
}
