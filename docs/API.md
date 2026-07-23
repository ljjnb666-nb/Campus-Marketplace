# 接口与交互说明

## Route Handlers

当前项目仅保留少量读取型接口：

- `GET/POST /api/auth/[...nextauth]`
  Auth.js 登录、会话与退出
- `GET /api/messages/conversations`
  当前用户的会话列表
- `GET /api/messages/conversations/[id]`
  指定会话的消息详情
- `GET /api/user/live-summary`
  当前用户的未读消息、未读通知与进行中订单摘要

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
- 资源读写默认按用户归属、状态和软删除条件过滤
- 当前阶段优先保证网页主流程，不额外封装一套完整 REST 写接口
