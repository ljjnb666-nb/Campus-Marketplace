# R3D-02C-07D01｜纠纷治理与账户执法的系统级收敛审计

> 审计日期：2026-10-21；审计起点：Draft #192 `91325799e376d17798d0e3dc7f82daa103c12b3b`；本修复切片作为 Draft 堆叠候选，**不代表生产验收，不得未经授权合并**。

## 一、证据等级与现存事实

| 证据 | 已能证明 | 不得据此宣称 |
| --- | --- | --- |
| #184—#192 的 AST + shadow Prisma 7.10.1 + 真实 PG/MinIO | 原版 TxLocked 内核的校区 RBAC、真实锁等待、DataHold、AdminAudit、原版 claim/release、原版撤权与停用的双向并发、规范通知负面/正面路径 | 生产 Prisma 7 可迁移、完整服务路由端到端、真实生产 `withTransaction` 兼容 |
| #192 exact HEAD CI #39560661461 | 4,770/4,770 Vitest、107/107 Playwright、Typecheck / Lint / Next Build SUCCESS | 测试用例之外的真实管理员浏览器操作、生产数据/资源规模 |
| #192 exact HEAD Worker #39560661379 | 五镜像真实 PG/MinIO 场景及 07C04B canonical IN_APP 幂等通过 | SMTP/EMAIL 已送达、消息已被用户阅读 |
| 当前主干 `0f7e51aa54fd57441f59d90db632cb96a47b44f4` | 主干当前未引入堆叠候选 | #184—#192 内容已经在主干或生产部署 |
| 生产 `src/lib/prisma.ts` | 使用 Prisma 6.19.3 的 `prisma.$extends(...)`、`withTransaction` 默认 10,000ms 超时 | 隔离 Prisma7 15,000ms 测试等价于当前生产封装 |

保留历史首次失败：#184 Worker 首次失败；#185 某旧 HEAD Next Retry；#191 原始 HEAD Worker 因 shadow 遗失 `acquireGovernanceSubjectLocks` 导入而 ReferenceError，补充导入后才 PASS。绿灯不删除失败事实。ESLint 63 warnings、PG locale、Redis overcommit、Actions Node20→24 与 Docker credential plaintext 警告不应被绿色结论覆盖。

## 二、生产真实入口链（已作代码只读交叉核查）

### 2.1 租赁纠纷终局

`src/app/governance/disputes/[disputeId]/page.tsx`
→  `src/components/governance/dispute-review-forms`
→  `src/actions/governance-disputes.ts`（`requireUser`、`loadAuthorizationContext` 与 kind 验证；ORDER/RENTAL 显式分流）
→  `src/lib/disputes/dispute-service.ts`（出租业务）
→  `src/lib/prisma.ts:withTransaction`（真实生产依赖仍是 Prisma6）
→  锁顺序 USER actor/owner/renter → RentalDispute FOR UPDATE → RentalOrder FOR UPDATE → fresh RBAC → 终局状态 → 订单状态 / status log → source-linked DataHold 释放 → append-only AdminAudit → canonical 双方通知。

独立审计结论：真实源码层的 Next.js 到领域服务调用链**存在**，且区域可见性/越权约束集中在服务内；但是已有大量 PG 证据来自 AST 摘取后的 shadow adapter，而非在生产 Prisma6 全服务入口上发起的真实租赁终局浏览器 E2E。真实 Server Action 单元测试的服务函数是 mock，不能替代集成证据。

### 2.2 账号停用/恢复

`src/app/governance/users/[userId]/page.tsx`
→  `src/components/governance/user-action-forms.tsx`
→  `src/actions/governance-users.ts`（GLOBAL `user.suspend` fail-fast）
→  `src/lib/enforcement/account-enforcement-service.ts`（权威 TxLocked；post-commit best-effort `emitNotificationTx`）
→  `src/lib/prisma.ts:withTransaction`。

原版返回 `status`、`alreadyInState`、`notificationDelivered`；其中最后字段表示写入规范通知成功，并不代表最终用户阅读或邮件投递。

**本轮发现并直接修复的 P2 用户可见缺口**：旧 Server Action 丢弃 `notificationDelivered`，`user-action-forms.tsx` 无条件只显示“操作已提交”，可能在账号已停用但 IN_APP 生成失败时隐藏部分成功事实。

本 Draft 仅增加 `notificationStatus = RECORDED | FAILED | NOT_REQUIRED`：
- RECORDED：权威操作成功且 IN_APP 物化成功（不代表已读）。
- FAILED：权威操作已提交，IN_APP 未物化；界面明确警示无需重复执行账号状态变更。
- NOT_REQUIRED：幂等无状态变化，无需新通知，不误报失败。
本语义同时应用 suspend / reinstate，保留 deny 家族统一报错和源级鉴权；没有修改原版锁、审计、通知服务、资金或Schema。

## 三、仍不可声称已解决的真实系统边界

1. **全应用端到端缺口（P1 发布门）**：使用固定 Prisma6.19.3、真实生产 `withTransaction`、管理员会话和 Next Server Action，在隔离部署上完成真实租赁纠纷终局 / 用户停用 / 撤权交错与数据库副作用实测；不能用 shadow Prisma7 函数验证替代。
2. **事务超时/锁等待（P2）**：真实 `withTransaction` 默认 10s；shadow PG 某些证据事务使用 15s 配置。需以生产预算复验排队并发及必要重试策略，确认超时后无混淆的成功/失败与双写。
3. **提交后视图刷新（P2 待核）**：`src/actions/governance-users.ts` 先完成 domain COMMIT 后调用 `revalidatePath`。刷新失败可能导致“成功已提交但操作返回错误”的歧义；尚未模拟或验证该异常，不在本 Draft 修复范围。
4. **真实客户端反馈（P2 待核）**：本 Draft 的客户端状态文本与结构有 Vitest 边界测试，但未做真实 Microsoft Edge 上的管理员账号登录、页面状态切换和网络失败验收。
5. **端到端通知可见性（P2 待核）**：#192 证明 PG IN_APP 投影，不代表真实用户 Session 能在通知列表读取、分页、标记已读；ACCOUNT_SUSPENDED 的 canonical registry 仅 IN_APP，EMAIL dispatcher 不在本通知类型的成功条件。
6. **生产/信任发布门（P1）**：UNVERIFIED、五项 trust=false、G1–G6/KPI 限制以及 #157/#97/#115/#120/#131 OPEN 必须保持。CI/单元测试通过不能提升生产可信度；#170—#192 未合并的堆叠状态必须单独治理，禁止将 Draft 链等同发布版本。

## 四、本切片收敛准入条件

- 本 PR 以 #192 的准确 HEAD 堆叠，代码差异必须限于治理账号 Action、反馈组件、对应测试与本审计文档。
- 准确 HEAD 重新执行 Typecheck、Lint、全量 Vitest、Next Build、Playwright 和真实五镜像 Worker，并读取原始测试数量；历史错误与 warning 保留。
- 对 `FAILED` 的反馈不得把已提交账号状态伪装成失败；`RECORDED` 不得写成“已送达/已读”；`NOT_REQUIRED` 不得冒充通知错误。
- 未经用户明确授权不得合并 Draft，不修改 master、不执行生产部署、不更改生产 Prisma 6.19.3、UNVERIFIED 或信任/KPI 发布限制。

本审计是**已经核查的源代码与真实 CI 证据的收敛报告**，非正式生产安全认证。