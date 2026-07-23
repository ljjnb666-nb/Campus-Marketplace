# 校园集市 - 消息中心与交易沟通体系审计报告 (MESSAGE_CENTER_AUDIT)

## 一、 当前消息相关路由与结构

1. **`/messages`** (`src/app/messages/page.tsx`)
   - 现仅作为简单列表入口，没有根据桌面/移动端适配双栏架构，搜索与筛选机制不健全。
2. **`/messages/[id]`** (`src/app/messages/[id]/page.tsx`)
   - 现为独立聊天页面，在桌面端下依然全屏渲染，没有与左侧会话列表进行双栏整合。
3. **`/notifications`** (`src/app/notifications/page.tsx`)
   - 现用于展示系统及交易 notification 列表，缺乏单条/全量标记已读及按“系统通知 / 订单通知 / 私信”的分类快速联动。

---

## 二、 核心数据模型 (Prisma Schema 现状与扩展规划)

### 1. 现有模型分析
- **`Conversation`**: 
  - 现包含 `id`, `title`, `productId`, `errandTaskId`, `serviceListingId`, `createdAt`, `updatedAt`。
  - **缺陷**: 缺失 `rentalListingId`（租赁物品）、`orderId`（普通商品/跑腿/服务订单）与 `rentalOrderId`（租赁订单）关联；缺失联合唯一标识，导致无法在数据库层保证同一对用户针对同一业务对象只会存在一个 Conversation。
- **`ConversationParticipant`**:
  - 包含 `id`, `conversationId`, `userId`, `joinedAt`, `lastReadAt`。
  - 包含唯一索引 `@@unique([conversationId, userId])`。
- **`Message`**:
  - 包含 `id`, `conversationId`, `senderId` (系统消息时为空), `type` (`DIRECT` / `SYSTEM` / `ORDER_STATUS`), `content`, `isRead`, `createdAt`。
- **`Notification`**:
  - 包含 `id`, `userId`, `orderId`, `type`, `title`, `content`, `isRead`, `createdAt`。
- **`BlockedUser`**:
  - 包含 `id`, `blockerId`, `blockedUserId`, `reason`, `createdAt`。包含 `@@unique([blockerId, blockedUserId])`。
- **`Report`**:
  - 包含 `id`, `targetType` (`USER` / `PRODUCT` / `ERRAND` / `SERVICE` / `RENTAL` / `MESSAGE`), `messageId`...

### 2. Schema 演进计划 (无需破坏现有库，仅新增可选项)
在 `Conversation` 中补充关联：
- `rentalListingId  String?`
- `orderId          String?`
- `rentalOrderId     String?`
- `rentalListing    RentalListing? @relation(...)`
- `order            Order?         @relation(...)`
- `rentalOrder       RentalOrder?   @relation(...)`

---

## 三、 会话发起 Server Actions 现状

目前支持的 Actions（定义在 `src/actions/conversation.ts`）：
- `createOrOpenProductConversation` (二手商品)
- `createOrOpenServiceConversation` (技能服务)
- `createOrOpenErrandConversation` (跑腿任务)

**待补全与统一项**：
- `createOrOpenRentalConversation` (租赁物品)
- `createOrOpenOrderConversation` (统一订单/租赁订单直接联系交易对方)
- 服务端会话防重机制优化（使用事务锁 + 统一查找与自动复用）

---

## 四、 各业务板块与订单中心发起会话链路

1. **二手商品详情** (`/products/[id]`): 点击“私聊卖家” -> 调用 `createOrOpenProductConversation`
2. **跑腿任务详情** (`/errands/[id]`): 点击“私聊发布者/接单者” -> 调用 `createOrOpenErrandConversation`
3. **技能服务详情** (`/services/[id]`): 点击“私聊服务者” -> 调用 `createOrOpenServiceConversation`
4. **租赁物品详情** (`/rentals/[id]`): **需新增**私聊出租者通道 -> 调用 `createOrOpenRentalConversation`
5. **统一订单中心与订单详情** (`/my/orders`, `/rental-orders/[id]`): **需新增**“联系对方”按钮 -> 调用 `createOrOpenOrderConversation`

---

## 五、 未读消息计算与同步机制

- **当前计算方式**: 在 `conversation-repository.ts` 中查找 `ConversationParticipant.lastReadAt`，比较当前会话最新消息时间。
- **改进点**:
  - 导航徽标计算: `未读私信会话数 + 未读通知数`。
  - 打开会话时，实时更新 `lastReadAt = new Date()` 且该会话所有 `isRead = true`。
  - 避免将自己发送的消息算作自己的未读。

---

## 六、 轮询与刷新策略

- **当前问题**: 页面粗暴使用定时器 `router.refresh()`，容易造成重绘、丢焦点或重复并发请求。
- **优化方案**:
  - 当前打开会话中消息区：采用 **3 秒轮询** 请求精简增量 API。
  - 会话列表与未读总数：采用 **12 秒轮询**。
  - 监听页面 `document.hidden`：当标签页不可见时自动暂停轮询，获得焦点 (`focus`) 时立即触发一次刷新。
  - 组件卸载 (`useEffect cleanup`) 强制清除定时器。

---

## 七、 权限、安全性与内容治理

1. **会话隔离**: 所有的读/写/发送操作必须校验 `userId in conversation.participants`。
2. **拉黑阻断**: 发送消息前检查 `BlockedUser` 记录。被拉黑后不可发送新消息（若存在进行中订单提示“当前订单履约中，沟通可能受限制”）。
3. **防伪造**: `SYSTEM` 与 `ORDER_STATUS` 类型消息只能由服务端系统在订单状态变更或审核事件触发时自动产生，不允许普通客户端上传 `type="SYSTEM"`。
4. **纯文本与 XSS 防范**: 消息渲染全量使用纯文本节点，禁止任何 `dangerouslySetInnerHTML`。

---

## 八、 重复会话防护与唯一性保障

- 针对同一交易类型 + 同一业务对象 ID (`productId` / `serviceListingId` / `errandTaskId` / `rentalListingId` / `orderId` / `rentalOrderId`) 以及相同参与者对 `[userId, counterpartId]`，建立服务端查重函数 `findOrCreateUniqueConversation`。
- 在 Prisma 事务中先 `findFirst`，若没有则在事务中创建并生成初始化关联与提示消息。

---

## 九、 历史消息向上分页

- 消息默认只加载最新的 20 条，按 `createdAt: "asc"` 倒序排列。
- 向上滚动触顶时加载上一页消息（使用 `cursor: messageId`），避免长会话一次性全量加载卡顿。

---

## 十、 组件复用与新建计划

### 复用组件
- `PageContainer`, `Breadcrumb`, `PriceDisplay`, `StatusBadge`, `UserSummaryCard`, `ReportDialog`

### 新建/重构组件
- `ConversationLayout`: 桌面端双栏（350px 列表 + 自适应聊天区），移动端单栏路由切换。
- `ConversationList`: 左侧搜索、业务标签过滤（二手/跑腿/服务/租赁/订单）、未读 Badge、进行中订单提示。
- `ChatHeader`: 对方头像、昵称、认证标识、关联对象详情悬浮卡片、举报/拉黑操作菜单。
- `ChatMessageList`: 气泡类型渲染（自己/对方/系统/订单变更）、已读状态、日期分割线、向上加载更多。
- `ChatInput`: 支持 IME 组合状态处理、Enter/Shift+Enter 发送控制、发送中 Loading、失败重试。
- `BlockDialog`: 拉黑用户二次确认与解封操作。

---

## 十一、 预计修改与新建文件清单

1. `prisma/schema.prisma` (更新 Schema 并生成 client)
2. `docs/MESSAGE_CENTER_AUDIT.md` (本文件)
3. `src/validators/conversation.ts` (补全校验 Schema)
4. `src/repositories/conversation-repository.ts` (增加关联对象聚合、唯一性检索、向上分页、未读更新)
5. `src/actions/conversation.ts` (升级会话创建、租赁/订单发起通道、消息发送权限与拉黑拦截)
6. `src/actions/trust.ts` (增加 `blockUser` 与 `unblockUser` Server Action)
7. `src/app/messages/page.tsx` (统一消息中心桌面双栏 / 移动端会话列表)
8. `src/app/messages/[id]/page.tsx` (移动端独立聊天页)
9. `src/app/notifications/page.tsx` (系统通知与订单通知中心)
10. `src/components/conversation/*` (全套响应式聊天与会话组件)
11. `src/components/site/header.tsx` 与 `user-menu.tsx` (同步未读数 Badge)
12. 对应单元测试文件 (`*.test.tsx`, `*.test.ts`)
