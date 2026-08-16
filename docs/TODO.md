# 开发计划

## Phase 1

- [x] 初始化 Next.js + Tailwind + Prisma
- [x] 使用 Docker Compose 配置本地 PostgreSQL
- [x] 设计 Prisma Schema
- [x] 接入 Auth.js 凭证登录
- [x] 创建首页、登录、注册和基础列表页
- [x] 建立 PRD / 架构 / 数据库 / API / 安全文档

## Phase 2

- [x] 商品详情、发布、编辑、上下架
- [x] 商品收藏
- [x] 跑腿接单流转
- [x] 技能服务详情、发布、编辑、上下架
- [x] 用户中心与校园认证页

## Phase 3

- [x] 订单流转与评价
- [x] 会话列表与站内消息
- [x] 举报系统
- [x] 管理后台
- [x] 搜索结果页、公开用户主页、分类与关键词管理
- [x] 任务分类模型、后台维护和前台筛选联动
- [ ] 测试补齐与体验优化

## 当前待补

- [ ] 继续补齐剩余少量页面交互与端到端关键流程测试
- [ ] 继续做少量低频页面文案与体验收尾
- [ ] 增加更稳定的浏览器侧回归检查

## 最近进展

- [x] 修正 `prisma/seed.ts` 和 `src/lib/auth.ts` 中的乱码源头
- [x] 重写商品、跑腿、服务三类详情页及其测试
- [x] 修正商品、跑腿、服务状态常量与推荐理由文案
- [x] 新增 `npm run app:smoke:auth`，覆盖 `profile`、`my/*`、`messages`、`notifications`、`verification` 等登录态主链路
- [x] 保持 `npm run db:verify`、`npm run app:smoke`、`npm run app:smoke:auth` 可重复通过
- [x] 新增 `npm run text:verify`，把常见中文乱码片段纳入源码和文档检查

## 当前测试基线

- `142` 个测试文件
- `459` 个测试通过（另有 3 个跳过）
