# 数据治理（Data Governance）

> Production Phase 5 交付物。路线权威见 [MASTER_ROADMAP.md](MASTER_ROADMAP.md)；
> 法务文本与同意机制见 [LEGAL_GOVERNANCE.md](LEGAL_GOVERNANCE.md)；
> 运维操作见 [PRIVACY_OPERATIONS.md](PRIVACY_OPERATIONS.md)。

## 1. 数据分类 registry（代码化 source of truth）

`src/lib/governance/data-classification.ts` 是分类/保留的唯一代码化定义。
Phase 6 RBAC 与 Phase 9 background retention cleanup 必须复用这里，
不得在各自 route 重新发明分类。

| 分类级别 | 含义 |
| --- | --- |
| `PUBLIC` | 可公开（如前台公开资料字段） |
| `INTERNAL` | 内部运行数据（如 requestId、资源登记元数据） |
| `CONFIDENTIAL` | 仅本人/业务必要方（订单、消息、同意证据） |
| `RESTRICTED` | 仅授权处理角色（凭据材料、认证材料、纠纷证据、未来支付数据） |

主要类别速览（完整定义以 registry 为准）：

| category | 分类 | 保留触发 | 处置 | 法律审查 |
| --- | --- | --- | --- | --- |
| PUBLIC_PROFILE | PUBLIC | 账号存续 | ANONYMIZE（注销时） | 否 |
| LOGIN_IDENTIFIER_EMAIL | CONFIDENTIAL | 账号存续 | ANONYMIZE（注销即清除原值） | 否 |
| PASSWORD_HASH | RESTRICTED | 账号存续 | ANONYMIZE（注销即失效） | 否 |
| CAMPUS_VERIFICATION_DATA | RESTRICTED | 提交认证 | DELETE（审核后 30 天，Phase 1 既有规则） | 否 |
| PRIVATE_VERIFICATION_ASSET | RESTRICTED | 上传/绑定 | DELETE（30 天/到期） | 否 |
| PRIVATE_MESSAGES | CONFIDENTIAL | 消息创建 | REVIEW_REQUIRED | **是** |
| ORDER_DETAILS | CONFIDENTIAL | 订单创建 | KEEP（pseudonymous 引用） | **是** |
| REPORTS / DISPUTE_EVIDENCE | CONFIDENTIAL/RESTRICTED | 创建时 | KEEP（治理证据） | **是** |
| ADMIN_SECURITY_LOGS / REQUEST_IDS | RESTRICTED/INTERNAL | 事件发生 | DELETE（≤30 天，LOG_PRIVACY §3） | 否 |
| UPLOADED_ASSET_METADATA | INTERNAL | 资源登记 | KEEP（审计行） | 否 |
| POLICY_ACCEPTANCE_EVIDENCE | CONFIDENTIAL | 同意行为 | KEEP（审计证据） | 否 |
| PRIVACY_REQUESTS | CONFIDENTIAL | 请求创建 | KEEP | **是** |
| FUTURE_PAYMENT_DATA | RESTRICTED | 未适用（Phase 15+） | REVIEW_REQUIRED | **是** |

红线：

- **不虚构法定保存年限**——需要真实法律判断的 duration 一律
  `{ kind: "PENDING_LEGAL_REVIEW" }` + `legalReviewRequired: true`；
- 固定天数（FIXED_DAYS）当前仅两条，均来自仓库既有真实规则
  （认证材料 30 天 = Phase 1 `VERIFICATION_ASSET_RETENTION_DAYS`；
  日志 30 天 = docs/LOG_PRIVACY.md §3）；
- 未注册类别按敏感处理、禁止自动清理（fail closed）。

helper：`isSensitiveDataCategory()` / `canIncludeInExport()` /
`getRetentionDecision()`——供导出边界、Phase 9 清理调度复用。

## 2. 保留策略 foundation 与 Phase 9 边界

Phase 5 定义 **WHAT**（决策），Phase 9 实现 **WHEN/HOW**（调度）：

- Phase 5 提供：retention 决策 helper、hold 检查、同步隐私操作、
  删除/匿名化服务、敏感资产到期标记（复用 Phase 1 `storage:cleanup`）；
- Phase 5 **不建**：cron、background worker、transactional outbox、
  dead-letter queue、通用 job scheduler。

## 3. 隐私请求域（PrivacyRequest）

| type | 说明 |
| --- | --- |
| `DATA_EXPORT` | 数据导出（允许重复请求，限流 5 次/15 分钟） |
| `ACCOUNT_DELETION` | 账号注销（同一用户同时至多一个 active 请求——数据库部分唯一索引兜底） |

状态机（显式 transition helper，禁止任意赋值）：

```
REQUESTED → IN_PROGRESS → COMPLETED
                        → BLOCKED（ACTIVE_DATA_HOLD / ACTIVE_TRANSACTION_BLOCK）
REQUESTED → CANCELLED
BLOCKED   → IN_PROGRESS（治理解除后重试）→ REJECTED（治理最终拒绝）
COMPLETED / CANCELLED / REJECTED 为终态
```

- BLOCKED 请求保留请求记录与机器可读 `reasonCode`；
- 重复创建 active 注销请求 → `PRIVACY_REQUEST_ALREADY_ACTIVE`（409）；
- 所有权：userId 一律从认证会话解析，API/Action 不接受外部 userId
  （防代他人提交）；用户只能创建/查看/取消自己的请求。

## 4. 数据导出（DATA_EXPORT）

实现：`src/lib/privacy/data-export.ts` + `GET /api/privacy/export`。

**边界（NO_CROSS_USER_EXPORT / NO_SECRET_EXPORT / NO_STORAGE_INTERNAL_LEAK）**：

- 显式 DTO 白名单（`UserExportPayload`），绝不 `SELECT *` + 直接序列化；
- 他人（counterparty）仅暴露公共字段 `id / name / avatarUrl`
  （与前台公开资料一致；已注销者自然呈现"已注销用户"占位）；
- 绝不输出：passwordHash、session token、objectKey、bucket、内部端点、
  他人 email/phone/认证材料、内部治理备注；
- 运行时出口 + 测试共用 `assertNoForbiddenExportFields` 递归扫描禁止键；
- 体积上限 `EXPORT_MAX_BYTES`（8MB），超限显式 `DATA_EXPORT_TOO_LARGE`
  （Phase 9 异步导出的边界已在 docs 记录，本阶段不造后台任务系统）。

响应安全：authenticated + same-user only；`Cache-Control: private, no-store`；
`X-Content-Type-Options: nosniff`；限流 3 次/15 分钟；每次导出留痕
DATA_EXPORT 请求记录。

## 5. 账号注销 / 匿名化（ACCOUNT_DELETION）

实现：`src/lib/privacy/account-erasure.ts`（eraseAccount）。

**绝不 `prisma.user.delete()`**——保留 pseudonymous 行以维持
订单/评价/举报/审计的 referential integrity。

前置检查（**事务内执行，TOCTOU 防护**）：

1. `erasedAt` 已存在 → `ACCOUNT_ALREADY_DELETED`；
2. active DataHold（LEGAL/DISPUTE）→ `ACTIVE_DATA_HOLD`；
3. 进行中订单（PENDING/ACCEPTED/IN_PROGRESS）→ `ACTIVE_TRANSACTION_BLOCK`；
4. 进行中租赁订单（PENDING_APPROVAL…IN_DISPUTE）→ `ACTIVE_TRANSACTION_BLOCK`；
5. 任一命中 → 整体失败，**绝不部分删除**（前置检查全部只读、先于任何写）。

匿名化动作（单事务）：

| 字段 | 处置 |
| --- | --- |
| name | → `已注销用户`（公共/UI 表示） |
| email | → `erased-<uuid>@erased.invalid`（随机 surrogate，**绝不用 SHA256(原 email)** 等可反查派生） |
| passwordHash | → 随机 bcrypt 哈希（原凭据永不匹配） |
| avatarUrl / bio / phone / college / grade / studentIdLast4 / lastLoginAt | → null |
| verificationStatus | → UNVERIFIED；UserVerification 行保留但 PII 字段清除 |
| 认证/交接/举报等敏感资产 | `expiresAt = now` → 既有 `storage:cleanup` 物理删除对象 |
| 进行中 listings | Product/Service/Rental → `OFFLINE`；ErrandTask → `CANCELLED`（不留"已注销账号 + 可交易 listing"） |
| Session 表行 | 全部删除（JWT 策略下为纵深防御） |

保留（pseudonymous）：历史订单、评价（本人署名变为匿名占位）、举报、
同意证据、隐私请求台账——身份字段已匿名，业务/治理完整性不受破坏。

**Auth revocation**：

- 新登录：`authorize()` 校验 `erasedAt` → 拒绝；
- 既有会话：`requireUser()` / `getVerifiedSession()` 每请求对照 DB 最新状态
  → 注销后所有受保护页面/API 立即失效；
- 客户端在注销成功后主动 signOut；
- 已知限制（JWT 架构）：纯公开只读页的顶栏个性化展示在 JWT 自然过期前
  可能残留（无任何数据访问），记录于 SECURITY.md。

## 6. Data Hold（Legal / Dispute Hold）

模型 `DataHold`：`type(LEGAL|DISPUTE)` / `status(ACTIVE|RELEASED)` /
`scope`（预留，当前 `USER_ACCOUNT`）/ `subjectType` / `subjectId` /
`reasonCode` / 审计字段（createdById/releasedById/releasedAt）。

- active hold **阻断**破坏性擦除/匿名化与保留期清理（`assertNoActiveHold`）；
- **Serialization contract（REPAIR）**：`createHold` / `releaseHold` /
  `eraseAccount` 在各自事务内先取得**同一把 subject advisory lock**
  （`pg_advisory_xact_lock`，键 = 命名空间 + hashtext(subjectType:subjectId)）。
  PostgreSQL 默认 READ COMMITTED——"事务内再查一次 hold"只能看见检查时点
  已提交的行，不构成 serialization boundary；锁把 check→commit 窗口
  彻底互斥关闭，保证：
  1. erase 先取锁 → check 无 hold → 提交 → hold 创建随后发生；或
  2. hold 先取锁 → 提交 → erase 后取锁 → check 见 hold → BLOCK。
  "hold 已提交而 erase 未见 hold 即提交"不可能出现（真实 PG 竞态测试
  HOLD_ERASURE_POST_CHECK_RACE_TEST 以 barrier seam 证明 lock ordering）；
- Phase 5 仅提供 service seam（`createHold`/`releaseHold`，测试与 seed 使用）；
  **不建**生产 debug endpoint；管理界面属 Phase 6 RBAC / Phase 7 运营后台。

## 7. 会话吊销与 active-account resolver（REPAIR）

Auth.js 策略为 JWT（maxAge 7 天）：`auth()` 只解析令牌，不感知注销。
所有 authenticated 边界（页面、Server Action、API route）一律经过
`src/lib/server-auth.ts` 的中央 resolver（`requireUser` /
`requireVerifiedPageUser` / `getVerifiedSession` 共同一份 DB 复核逻辑）：

```
解析 session → DB re-fetch User → status==ACTIVE && deletedAt==null && erasedAt==null
```

- 该校验**任何路径都不可跳过**（consent gate 允许豁免，账号 active 校验不允许）；
- consent 是否要求由调用方决定：re-consent（`/legal/accept`、
  `POST acceptances`）与隐私自助（导出/注销）使用 `requireConsent=false`；
- 注销后残留的旧 JWT：页面重定向 /login；API 返回 401 `ACCOUNT_INACTIVE`；
  E2E（GF-P5/GF-P6）以"保留 cookie → DB 注销 → 旧 cookie 直调边界"的方式回归。

## 8. 数据导出生命周期（REPAIR 2：失败台账持久化）

同步导出的唯一执行入口是 `GET /api/privacy/export`
（服务层 `executeSynchronousDataExport`）：

```
成功：REQUESTED → IN_PROGRESS → 构建 DTO → 禁止键扫描/体积校验
      → COMPLETED（completedAt）→ 事务 COMMIT → 响应载荷
失败：REQUESTED → IN_PROGRESS → REJECTED(reasonCode) → 事务 COMMIT
      → 事务外再向调用方抛出安全错误
      （reasonCode: DATA_EXPORT_TOO_LARGE / EXPORT_EXECUTION_FAILED）
```

- 一次导出 = **恰好一条** PrivacyRequest；失败路径在事务 callback 内
  **return** 失败结果，使 REJECTED 台账随事务提交持久化，错误在提交之后
  才上抛（此前"catch 内 REJECTED 再 throw"会被 interactive transaction
  整体 rollback 吞掉——真实 PG 测试
  SYNC_EXPORT_FAILURE_PERSISTS_REJECTED_TEST 以新连接查库锁定该语义）；
- snapshot 语义（准确表述）：request lifecycle 在单一事务内提交；
  DTO 构建使用普通 DB 读（独立快照），不声称与 lifecycle 同一快照；
- `POST /api/privacy/requests` 对 DATA_EXPORT 返回 400 `USE_EXPORT_ENDPOINT`
  （指引唯一入口）；"只创建 REQUESTED 不执行"的低层入口
  （createDataExportRequest）已删除，防止孤儿请求回归；
- 速率限制在同一执行入口内完成（3 次/15 分钟）。

## 8b. 交易义务创建的 participant guard（REPAIR 2）

任何创建"持续性 active obligation"的写事务——商品订单 / 服务预约 /
跑腿接单 / 租赁订单——在创建义务前必须：

1. 对全部 USER 参与方按稳定顺序取得 governance subject 锁
   （`acquireGovernanceSubjectLocks`：去重 + `subjectType:subjectId`
   组合键升序；禁止任何路径按相反顺序自行加锁造成死锁环）；
2. 持锁事务内重读参与方（`assertActiveGovernanceSubjects`）：
   `status==ACTIVE && deletedAt==null && erasedAt==null`；
3. 通过后才执行 domain 状态检查与义务创建（`withObligationGuard`，
   含测试 seam）。Policy 锁命名空间与 USER subject 命名空间保持隔离。

与 `eraseAccount` 的同一把 subject 锁配合，线性化保证只有两种结果：

- **A**：obligation 先取锁 → 提交 → erase 后取锁 → active-transaction
  检查看到义务 → BLOCKED；
- **B**：erase 先取锁 → 提交匿名化 → obligation 后取锁 → 参与方复核失败
  → 创建被拒（`GOVERNANCE_SUBJECT_INACTIVE`）。

绝不允许"erase active 计数为零 → 并发新义务提交 → erase 提交 →
已注销用户持有 active obligation"。真实 PG 竞态测试：
`ORDER_CREATION_ERASURE_RACE_TEST` / `RENTAL_CREATION_ERASURE_RACE_TEST`
（各覆盖 A/B 双向，barrier seam 非 sleep 同步）；service/errand 路径以
erased-participant 拒绝回归锁定 guard 接入。

范围边界：guard 只覆盖"创建新的持续性交易/履约义务"与"注销
active-transaction invariant"，不演变为全站写路径串行化（profile/listing
编辑等不取 participant 锁）。

## 9. 迁移与并发安全

- migration `20260902160220_add_legal_privacy_governance`：
  新增 4 表 + `User.erasedAt`；**不写业务数据、不改既有行**
  （fresh deploy PASS / second deploy PASS / existing DB 升级 PASS）；
- 数据库级不变量：
  - `LegalDocument (type, version)` 唯一；
  - `PolicyAcceptance (userId, documentId)` 唯一（幂等同意）；
  - `PrivacyRequest` 部分唯一索引：`userId WHERE type='ACCOUNT_DELETION'
    AND status IN ('REQUESTED','IN_PROGRESS','BLOCKED')`；
- serialization boundary（REPAIR）：hold/erasure 走 subject advisory lock；
  publish/retire/accept 走 policy advisory lock（按类型固定锁序，无死锁环）。
  recordAcceptances 的 resolve→validate→insert 全部在持锁事务内完成，
  与 publishLegalDocument 严格线性化——不存在"v2 已发布而 v1 同意仍以
  latest 成功提交"的交错；
- 并发场景均有真实 PG 集成测试：HOLD_ERASURE_POST_CHECK_RACE（LEGAL/DISPUTE，
  barrier seam 证明锁序）、POLICY_PUBLISH_ACCEPTANCE_RACE（双向线性化）、
  CONCURRENT_POLICY_PUBLISH_SERIALIZATION、并发接受幂等、并发发布唯一约束。

## 10. 日志与可观测边界

沿用 Phase 4 契约（docs/LOG_PRIVACY.md / OBSERVABILITY.md）。新增结构化事件
（仅 IDs / 安全枚举 / requestId，禁止内容本体）：

`policy_acceptance_created`、`reconsent_required`、`legal_document_published`、
`privacy_request_created`、`privacy_request_completed`、
`account_erasure_blocked`、`account_erasure_completed`、
`data_hold_created`、`privacy_export_served`。

绝不入日志：policy 全文、export payload、password、token、验证材料、
私密消息、hold 证据细节。
