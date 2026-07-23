# 校园集市 UI/UX 重构任务清单 (UI Refactor TODO)

## 阶段一：设计系统与基础 UI 组件库 (COMPLETED)
- [x] 18 个基础 UI 组件规范与底层适配

## 阶段二：详情页重构 (COMPLETED)
- [x] 二手商品详情页 `/products/[id]` 55%:45% Sticky 架构
- [x] 跑腿详情页 `/errands/[id]` 55%:45% Sticky 架构 + ErrandClaimDialog
- [x] 技能服务详情页 `/services/[id]` 55%:45% Sticky 架构 + ServiceBookingDrawer
- [x] 物品租赁详情页 `/rentals/[id]` 55%:45% Sticky 架构 + RentalBookingDrawer

## 阶段三：统一订单中心重构 (Order Center Refactoring - COMPLETED)
- [x] 订单系统审计与架构规范文档 `docs/ORDER_CENTER_AUDIT.md`
- [x] 统一订单状态标签组件 `src/components/order/order-status-badge-unified.tsx`
- [x] 统一订单时间线 `src/components/order/order-timeline.tsx`
- [x] 统一订单取消弹窗 `src/components/order/order-cancel-dialog.tsx`
- [x] 统一订单确认完成弹窗 `src/components/order/order-confirm-dialog.tsx`
- [x] 统一订单评价弹窗 `src/components/order/review-dialog.tsx`
- [x] 统一订单申诉/纠纷弹窗 `src/components/order/dispute-dialog.tsx`
- [x] 统一订单卡片组件 `src/components/order/order-card-unified.tsx`
- [x] 统一订单中心列表页 `src/app/my/orders/page.tsx`
- [x] 旧订单路由兼容与重定向 (`/my/rental-orders`, `/my/owner-orders`)
- [x] 租赁订单详情页 `src/app/rental-orders/[id]/page.tsx` 重构
