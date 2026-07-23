# 校园集市订单中心 UI 与交易闭环重构审计报告 (ORDER_CENTER_AUDIT.md)

## 一、当前订单路由与代码现状

### 1. 现有订单路由
- `/my/orders` — 旧版二手商品、跑腿及技能服务订单入口（包含买方与卖方双栏平铺）。
- `/my/rental-orders` — 租客视角租赁订单入口。
- `/my/owner-orders` — 出租者视角租赁订单入口。
- `/rental-orders/[id]` — 租赁订单详情页。
- `/rental-orders/[id]/handover` — 租赁交接验证页。
- `/rental-orders/[id]/return` — 租赁归还验收页。
- `/rental-orders/[id]/extend` — 租赁续租申请页。

---

## 二、模型与状态映射体系 (Order & RentalOrder)

### 1. 数据库模型双轨机制
1. **`Order` 模型**：支持 `PRODUCT` (二手商品), `ERRAND` (跑腿求助), `SERVICE` (技能服务)。
   - 字段包括：`orderNo`, `type`, `status`, `paymentStatus`, `amount`, `meetingLocation`, `note`, `buyerId`, `sellerId`, `productId`, `errandTaskId`, `serviceListingId`。
2. **`RentalOrder` 模型**：专门用于 `RENTAL` (物品租赁)。
   - 字段包括：`orderNumber`, `rentalListingId`, `ownerId`, `renterId`, `startTime`, `endTime`, `unitPriceSnapshot`, `pricingUnitSnapshot`, `rentalAmount`, `depositAmount`, `depositStatus`, `depositDeduction`, `status`, `handoverRecord`, `returnRecord`, `reviews`, `statusLogs`。

---

## 三、订单状态到用户导向中文指引映射

| 业务分类 | 数据库枚举状态 | 提示标题 (中文) | 针对当前角色的操作指引 |
|---|---|---|---|
| **二手商品** | `PENDING` | 等待卖家确认 | 买家可取消订单 / 卖家可确认售出或拒绝 |
| | `ACCEPTED` | 交付履约中 | 双方确认见面交付；买家可确认收货完成交易 |
| | `COMPLETED` | 订单已完成 | 交易成功，双方可发表评价 |
| | `CANCELLED` | 订单已取消 | 交易取消关闭 |
| **跑腿任务** | `OPEN` | 待抢单接单 | 普通用户可抢单；发布者可编辑或取消 |
| | `CLAIMED` / `IN_PROGRESS` | 任务进行中 | 接单者开始履约并提交完成；发布者确认完成 |
| | `PENDING_CONFIRMATION` | 待发布者验收 | 接单者已提交完成，等待发布者确认验收 |
| | `COMPLETED` | 跑腿完成 | 悬赏结清，双方可互评 |
| **技能服务** | `PENDING` | 待服务者确认 | 买家可取消预约 / 服务者可接单或拒单 |
| | `ACCEPTED` / `IN_PROGRESS` | 服务履约中 | 服务者执行服务并提交完成 |
| | `COMPLETED` | 服务已完成 | 预约结清，双方可互相评价 |
| **物品租赁** | `PENDING_APPROVAL` | 待出租者审核 | 租客可取消申请 / 出租者可同意或拒绝申请 |
| | `PENDING_PICKUP` | 待当面交接取货 | 双方在约定地点当面核对物品并确认取货 |
| | `IN_RENTAL` | 物品租赁使用中 | 租客使用中；可申请续租或发起归还 |
| | `PENDING_RETURN` | 待归还验收 | 租客已归还，等待出租者现场验收设备与配件 |
| | `PENDING_INSPECTION` | 损耗/定损处理中 | 出租者提交损坏说明，等待租客确认扣押金 |
| | `COMPLETED` | 租赁已结清归还 | 押金已结算退回，双方可互评 |
| | `CANCELLED` / `REJECTED` | 租赁已取消/拒绝 | 交易终止关闭 |

---

## 四、统一订单中心架构方案

我们将以统一入口 `/my/orders` 为核心，通过 URL 参数 `type` 统筹 6 大维度的视图，并重定向旧路由至对应筛选 Tab：

- `/my/orders` (默认: 全部订单)
- `/my/orders?type=product` (二手商品)
- `/my/orders?type=errand` (跑腿求助)
- `/my/orders?type=service` (技能服务)
- `/my/orders?type=rental-renter` (我的租用)
- `/my/orders?type=rental-owner` (我的出租)

---

## 五、重构实施 Checklist
- [x] 完成架构盘点与 `ORDER_CENTER_AUDIT.md`
- [ ] 创建统一订单状态标签组件 `OrderStatusBadgeUnified`
- [ ] 创建统一订单时间线 `OrderTimeline`
- [ ] 创建统一订单取消 Dialog `OrderCancelDialog`
- [ ] 创建统一订单确认完成 Dialog `OrderConfirmDialog`
- [ ] 创建统一评价 Dialog `ReviewDialog`
- [ ] 创建统一纠纷/申诉 Dialog `DisputeDialog`
- [ ] 创建统一订单卡片 `OrderCardUnified`
- [ ] 统一重构 `/my/orders` 路由，处理搜索、筛选与 Tab 分页
- [ ] 将旧路由 `/my/rental-orders` 与 `/my/owner-orders` 做无缝 Tab 激活兼容
- [ ] 重构租赁订单详情页 `/rental-orders/[id]`（引入 Sticky 双栏与时间线）
