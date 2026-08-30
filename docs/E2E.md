# E2E 测试（Playwright Release Gate）

Production Phase 2 建立的浏览器级回归门禁：真实用户通过 Chromium 完成全部关键业务状态机，
链路为 **真实浏览器 → Next.js（production build）→ Server Action → PostgreSQL / Redis / MinIO**，
关键业务 API 一律不 mock。

## 测试架构

```
playwright.config.ts          # webServer 以 production build 启动，指向 E2E 专用库
tests/e2e/
  auth-setup.ts               # setup 依赖项目：真实登录生成 storageState（.auth/*.json）
  helpers/
    e2e.ts                    # 账号常量 / uniqueTag 唯一数据 / fixture 路径
    auth.ts                   # loginViaUI / logoutViaUI
    db.ts                     # e2eDb()：直连 E2E 库做最终状态断言（DB verifies invariant）
  fixtures/images/            # sharp 生成的合成测试图（非真实证件/照片）
  auth-profile.spec.ts        # GF1 注册/登录/Profile
  product-flow.spec.ts        # GF2 商品发布（真实 MinIO 上传）/收藏/下单
  product-order-machine.spec.ts # GF3 订单状态机 + 无关用户负例
  errand-flow.spec.ts         # GF4 跑腿状态机
  service-flow.spec.ts        # GF5 技能服务预约
  rental-flow.spec.ts         # GF6 租赁全链路 + 私有资产 4 角色权限边界
  messaging-flow.spec.ts      # GF7 双用户站内消息
  report-admin-flow.spec.ts   # GF8 举报 → 管理员处理
  security.spec.ts            # 管理员越权 / 跨用户编辑 / 并发重复下单
scripts/
  e2e-setup.ts                # 建库 + migrate deploy + 全量重置 + 确定性账号 + Redis 限流清理
  e2e-teardown.ts             # 按资产行精确清理本轮 MinIO 对象 + 限流键
  run-e2e.ts                  # build → setup → playwright → teardown（跨平台编排）
```

## 依赖服务

本地：`docker compose up -d postgres redis minio`（MinIO bucket 与 E2E 专用账号由 `minio-init` 引导创建）。
默认连接：PG `campus_e2e` 库（5432）、Redis 6379、MinIO 9100。

首次需创建 E2E 数据库（已存在则跳过）：

```bash
docker exec campus-marketplace-postgres createdb -U postgres campus_e2e
```

### destructive reset 安全闸门

`e2e-setup` 会清空目标库全部业务表，受 `scripts/e2e-database-guard.ts` 硬性约束，
放行条件（全部满足）：`NODE_ENV != production` + 数据库名明确为 E2E 命名
（`e2e` 作为独立语义段，如 `campus_e2e`）+ host 为 loopback 或显式设置
`E2E_DESTRUCTIVE_RESET_ALLOWED=1`（仅供 E2E 专用环境；production 下无效）。
CI 将 `DATABASE_URL` 与 `E2E_DATABASE_URL` 指向同一 localhost E2E 库的形态
满足上述条件，可正常执行。日志只输出 sanitized URL（隐藏用户名/密码/query）。

## 常用命令

```bash
npm run e2e            # 一键：build → setup → playwright test → teardown
npm run e2e:headed     # 有头模式调试
npm run e2e:ui         # Playwright UI 模式
npm run e2e:setup      # 仅重置 E2E 库 / 账号 / 限流键
npm run e2e:teardown   # 仅清理 MinIO 本轮对象与限流键
```

只跑单个 spec（需先 `npm run e2e:prepare` 或已 build）：

```bash
npm run e2e:setup && npx playwright test tests/e2e/rental-flow.spec.ts
```

## 测试账号策略

账号**仅存在于 E2E 专用库**（`scripts/e2e-setup.ts` 创建），生产环境不生成任何固定测试账号：

| 角色 | 邮箱 | 用途 |
| --- | --- | --- |
| buyer | `e2e-buyer@e2e.test` | 买家 / 跑腿发布者 / 租客 / 举报人 |
| seller | `e2e-seller@e2e.test` | 卖家 / 接单者 / 出租者 |
| admin | `e2e-admin@e2e.test` | 管理员后台 |
| outsider | `e2e-outsider@e2e.test` | 无关用户负例 |

storageState（`.auth/*.json`）由 auth-setup **每次运行时真实登录生成**，已 gitignore，严禁提交。
GF1 的注册/登录/登出用匿名 context 走完整 UI，不依赖 storageState。

隔离策略：每个 spec 用 `uniqueTag()` 生成唯一标题/邮箱，`--repeat-each` 与并行 worker 互不串数据；
每轮 `e2e-setup` 全量重置 DB 并清空 `ratelimit:*` Redis 键（规避注册 5/h、登录 10/15min 限流）。

## DB / MinIO / Redis 清理

- **DB**：`e2e-setup` 按外键顺序清空全部业务表后重建分类与账号；测试数据不跨轮存活。
- **MinIO**：`e2e-teardown` 按 `uploadedAsset` 行精确删除本轮对象（即使测试失败也执行）；
  未登记孤儿对象由 `npm run storage:cleanup` 定期回收。
- **Redis**：setup/teardown 各清一次 `ratelimit:*` 命名空间，不触碰其它键。

## Golden Flows（8 条）

1. **AUTH_PROFILE**：匿名保护页 → 注册 → 登录 → 改资料持久化 → 登出（+ 错误密码负例）
2. **PRODUCT_PUBLISH_FAVORITE_ORDER**：发布（真实 MinIO 上传 + 公网取回验证）→ 搜索 → 收藏持久化 → 下单 RESERVED
3. **PRODUCT_ORDER_STATE_MACHINE**：下单 → 卖家接受 → 买家完成 → 商品 SOLD + 无关用户负例
4. **ERRAND**：发布 → 接单 → 开始 → 提交完成 → 发布者确认（发布者不可接自己的单）
5. **SERVICE**：发布 → 预约 → 接受 → 开始服务 → 完成
6. **RENTAL**：发布 → 申请 → 批准 → 双方交接（真实私有 MinIO 照片）→ 归还 → 验收完成
   + `/api/assets/{id}/access` 四角色边界（双方 200 / ADMIN 200 / 无关 403 / 匿名 401）
7. **MESSAGING**：私聊建会话 → 双向收发 → 刷新持久（DB 断言消息内容/发送者/参与方）
8. **REPORT_ADMIN**：举报 → 管理员标记处理中 → 处理完成（DB 断言 RESOLVED + 处理备注）

## 调试方法

- 失败产物在 `tests/e2e/.artifacts/`（screenshot + video + error-context.md，仅失败时保留）
- HTML 报告：`npx playwright show-report tests/e2e/.report`
- 本地默认 0 retry（问题立刻暴露）；CI retry=2、workers=2
- 禁止 `waitForTimeout` 驱动测试：一律 `expect(...).toBeVisible()` / `waitForURL` / `expect.poll`
  （弹窗动画后的跳转先断言成功文案再等 URL）

## CI Gate

`.github/workflows/ci.yml` 两个 job：

- **verify**：typecheck / lint / migration ×2 / coverage / build
- **e2e**（needs: verify）：PG + Redis service + docker MinIO → npm ci → playwright install chromium →
  bucket/账号引导 → prisma generate → build → `npm run e2e:setup` → `npx playwright test` →
  `npm run e2e:teardown`（always）→ 失败时上传 report/artifacts

e2e 失败即整个 CI 失败（无 continue-on-error / allow-failure）。两个 check 可设为
GitHub branch protection 的 required checks（当前仓库未配置 branch protection）。

## Flaky 政策

- 合入前本地连续 3 轮全绿（`npx playwright test` ×3），报告 first-attempt pass rate
- CI retry 掩盖的首跑失败视为 flaky，须修复而非加 retry
- 每 spec 独立造数据，单独运行任意 spec 必须可过
