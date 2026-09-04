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
- hold 校验必须在破坏性事务**内部**再次执行（集成测试证明 READ COMMITTED
  下事务内可见并发创建的 hold）；
- Phase 5 仅提供 service seam（`createHold`/`releaseHold`，测试与 seed 使用）；
  **不建**生产 debug endpoint；管理界面属 Phase 6 RBAC / Phase 7 运营后台。

## 7. 迁移与并发安全

- migration `20260902160220_add_legal_privacy_governance`：
  新增 4 表 + `User.erasedAt`；**不写业务数据、不改既有行**
  （fresh deploy PASS / second deploy PASS / existing DB 升级 PASS）；
- 数据库级不变量：
  - `LegalDocument (type, version)` 唯一；
  - `PolicyAcceptance (userId, documentId)` 唯一（幂等同意）；
  - `PrivacyRequest` 部分唯一索引：`userId WHERE type='ACCOUNT_DELETION'
    AND status IN ('REQUESTED','IN_PROGRESS','BLOCKED')`；
- 并发场景均有集成测试：并发接受、并发发布（唯一约束）、hold-vs-delete
  竞态（事务内复检）。

## 8. 日志与可观测边界

沿用 Phase 4 契约（docs/LOG_PRIVACY.md / OBSERVABILITY.md）。新增结构化事件
（仅 IDs / 安全枚举 / requestId，禁止内容本体）：

`policy_acceptance_created`、`reconsent_required`、`legal_document_published`、
`privacy_request_created`、`privacy_request_completed`、
`account_erasure_blocked`、`account_erasure_completed`、
`data_hold_created`、`privacy_export_served`。

绝不入日志：policy 全文、export payload、password、token、验证材料、
私密消息、hold 证据细节。
