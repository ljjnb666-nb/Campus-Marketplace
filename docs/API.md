# 接口与交互说明

## Route Handlers

当前项目仅保留少量轻量接口（读取型 + 上传 + 探活）：

- `GET/POST /api/auth/[...nextauth]`
  Auth.js 登录、会话与退出
- `GET /api/messages/conversations`
  当前用户的会话列表
- `GET /api/messages/conversations/[id]`
  指定会话的消息详情
- `GET /api/user/live-summary`
  当前用户的未读消息、未读通知与进行中订单摘要
- `GET /api/favorites/products|rentals|services|errands`
  当前用户四类收藏的列表读取（收藏的切换走 Server Action）
- `POST /api/upload/images`
  图片上传（MIME 白名单 + 魔数校验 + 按用户限流）；错误响应统一为
  `{ error: 中文提示 }`，内部异常不透传原始 message
- `GET /api/health`
  数据库探活，供部署层健康检查

## Server Actions

项目的大部分写操作通过 Server Actions 完成，包括：

- 商品发布、编辑、上下架、删除、收藏
- 跑腿任务发布、编辑、接单、状态流转
- 技能服务发布、编辑、上下架
- 商品 / 服务下单与订单状态更新
- 资料更新与校园认证提交
- 评价提交与举报提交
- 通知已读与后台管理动作

## 统一约束

- 所有敏感写操作都在服务端进行权限校验
- 资源读写默认按用户归属、状态和软删除条件过滤——软删除过滤由 Prisma client extension 统一注入（`src/lib/prisma-soft-delete.ts`），业务查询无需逐条手写
- 当前阶段优先保证网页主流程，不额外封装一套完整 REST 写接口
