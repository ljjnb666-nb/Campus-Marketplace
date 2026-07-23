# 数据库设计

## 核心模型

- `User`：用户、角色、状态、认证状态、公开资料
- `Campus`：校区
- `UserVerification`：校园认证提交记录
- `Product` / `ProductCategory` / `ProductImage`：二手商品
- `ErrandTask` / `ErrandCategory`：跑腿任务
- `ServiceListing` / `ServiceCategory`：技能服务
- `Order`：商品、任务、服务三类订单
- `Conversation` / `ConversationParticipant` / `Message`：站内会话与消息
- `Favorite`：商品收藏
- `Review`：订单后评价
- `Report`：举报
- `ModerationKeyword`：违禁关键词
- `Notification`：站内通知
- `AdminLog`：后台操作日志

## 设计原则

- 商品、任务、服务统一围绕“发布者 + 状态 + 校区”建模
- 订单统一抽象，避免三套独立交易流
- 敏感信息仅在服务端保留，不直接对前台开放
- 为支付、AI 审核、多校区扩展预留字段和状态模型

## 本地数据准备

- 迁移目录：`prisma/migrations`
- Schema：`prisma/schema.prisma`
- 种子：`prisma/seed.ts`

默认种子会写入：

- 1 个管理员
- 10 个学生用户
- 商品、跑腿、服务示例数据
- 订单、评价、会话与举报示例数据
