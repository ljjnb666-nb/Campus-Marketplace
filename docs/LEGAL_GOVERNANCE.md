# 法务与协议治理（Legal Governance）

> Production Phase 5 交付物。权威路线见 [MASTER_ROADMAP.md](MASTER_ROADMAP.md)；
> 数据分类/保留/删除语义见 [DATA_GOVERNANCE.md](DATA_GOVERNANCE.md)；
> 运维操作手册见 [PRIVACY_OPERATIONS.md](PRIVACY_OPERATIONS.md)。

## 0. 法律审查状态（必须首先阅读）

**`LEGAL_REVIEW_REQUIRED = TRUE`**

- 本仓库当前的全部法务文本（用户服务协议、隐私政策、平台规则、禁止交易红线）
  是**工程/产品治理基线**，不是法律意见。
- 不得声称"完全符合中国法律""已通过 PIPL 合规""满足监管要求"——
  在获得真实外部法律/合规审查之前，这类表述一律禁止。
- 同样禁止虚构：法定保存年限、法律备案状态、支付资质、ICP 完成状态、
  监管审批。涉及法定期限的条目一律标注 `PENDING_LEGAL_REVIEW`（见 DATA_GOVERNANCE）。
- **公开发布前置条件**：正式对外运营前，必须完成真实法律审查，
  并以"发布新版本"的方式替换基线文本（见 §2 发布流程）。

## 1. 文档域模型（LegalDocument）

| 字段 | 说明 |
| --- | --- |
| `type` | `TERMS_OF_SERVICE` / `PRIVACY_POLICY` / `PLATFORM_RULES` / `PROHIBITED_TRANSACTIONS` |
| `version` | 类型内递增整数；`(type, version)` 数据库唯一 |
| `status` | `DRAFT` → `PUBLISHED` → `RETIRED` |
| `content` | canonical 内容（UTF-8 原文） |
| `contentHash` | `sha256(canonical content)`，hex 小写 |
| `effectiveAt` | 生效时间；current 解析参与条件 |
| `requiresAcceptance` | 是否进入用户 required 集合 |

**核心不变量：PUBLISHED 即不可变（IMMUTABLE_ACCEPTED_CONTENT）**

- 一经发布，`type / version / content / contentHash / effectiveAt / requiresAcceptance`
  不得原地修改（`updateDraftLegalDocument` 仅接受 DRAFT）。
- 需要修改内容 → 创建新版本并发布；旧版本 RETIRED 后仍可追溯查看。
- 发布入口收敛在 `LegalDocumentService.publishLegalDocument`：
  - 事务内校验版本号必须高于该类型全部已发布版本（防倒序发布造成 current 漂移）；
  - `(type, version)` 数据库唯一约束兜底并发发布；
  - 同一文档重复发布幂等。

**current 解析（确定性，CURRENT_POLICY_RESOLUTION）**

- 仅 `status = PUBLISHED AND effectiveAt <= now AND requiresAcceptance` 参与解析；
- 同一 type 取 version 最高者；排序显式（`version desc, id asc`），
  绝不依赖数据库返回顺序；
- 未来生效版本（`effectiveAt > now`）发布后不进入 required 集合，到期自然生效。

## 2. 发布流程（当前阶段）

Phase 5 不建管理后台（Phase 7）。文档发布通过**受控的工程流程**执行：

1. 修改 `prisma/legal-seed-content.ts`（新增版本条目或调整内容为 v(n+1)）；
2. 由部署/运维流程执行 seed 发布（生产环境初始发布同样走该内容）；
   注意：**migration 本身不写业务数据**——生产已有库通过一次性运维命令
   （seed 发布逻辑为幂等 upsert，仅新增 `(type, version)`）或显式服务调用发布；
3. 每次发布在结构化日志留下 `legal_document_published`（id/type/version/hash）。

Phase 7 运营后台落地后，发布入口应迁移为后台操作 + AdminAuditLog（Phase 6 审计域）。

## 3. 同意证据（PolicyAcceptance）

每次用户同意固化一条审计证据：

- `userId + documentId`（唯一约束 → 幂等，并发双击不产生重复证据）；
- 快照三元组 `documentType / documentVersion / documentHash`
  —— 证据自足，即使脱离文档表也能证明"用户接受了哪个确切版本"；
- `source`：`SIGNUP` / `RECONSENT` / `SETTINGS`。
  **故意不设 MIGRATION 来源**——旧用户的重新同意必须来自真实用户行为，
  不存在"迁移自动补同意"这个合法状态（LEGACY_USER_POLICY）。
- 证据创建后不可改写为另一 version/hash（唯一约束 + 服务层防御）。

**旧用户（legacy）策略（Blocker 级要求）**

- Phase 5 之前注册的用户没有 acceptance 记录；
- 禁止：migration 自动插入、seed 伪装、`createdAt` 当 `acceptedAt`、默认 accepted；
- 实际行为：legacy 用户登录后访问任何业务面 → consent gate 引导至
  `/legal/accept` → 显式操作同意 → 生成 `RECONSENT` 证据；
- 测试基建（E2E fixture / dev seed）可以为**测试账号**插入
  `TEST FIXTURE ACCEPTANCE`，但该做法被显式标注且严禁用于生产 migration。

## 4. Consent Gate（不可绕过）

- **中央卡点**：`requireUser()`（页面 + 全部 Server Action 的统一入口）在
  账户状态校验后执行 `getUserAcceptanceStatus`；未满足 → `redirect("/legal/accept")`。
  所有业务 mutation 都经由 requireUser/requireAdmin 进入，无法通过直接调用绕过。
- **API 边界**：`getVerifiedSession({ requireConsent: true })` 用于业务 mutation
  API（当前为 `POST /api/upload/images`）；未满足返回
  `403 { code: "LEGAL_ACCEPTANCE_REQUIRED" }`。
- **可访问面（不受 gate 影响）**：未登录公开页（含 `/legal/*`）、登录/登出、
  同意页本身、健康检查（`/api/health`、`/api/ready`、metrics）。
- **隐私自助豁免（设计决定）**：数据导出与账号注销是用户基本权利，
  **不要求先同意新协议**（退出权优先）。`/my/privacy`、
  `/api/privacy/*`、`/api/legal/acceptances` 使用身份校验但跳过 consent gate。

## 5. 重新同意（Reconsent）

- required 集合中任一类型发布新版本 → 该类型既有同意变为 `OUTDATED`
  （按 documentType 语义匹配：同类型最近一次接受 ≠ 当前版本）；
- `/legal/accept` 展示：文档标题 / 类型 / 版本 / 生效日期 / 全文链接；
- **fail closed**：用户停留在旧集合上提交（打开页面期间版本发生变化）
  → 服务端重解析当前集合，集合不一致 → `LEGAL_DOCUMENT_VERSION_CHANGED`
  / `LEGAL_DOCUMENT_NOT_CURRENT`，要求重新加载；绝不把 stale 提交当作已同意；
- 新版本同意绝不自动延续：旧同意 ≠ 当前同意（OLD_VERSION_RECONSENT_REQUIRED）。

## 6. 注册流程（SIGNUP）

- 注册表单展示当前 required 文档（标题 + 版本 + 全文链接）+ 显式 checkbox；
- 提交时服务端校验"提交的文档 id 集合 == 当前 required 集合"，
  不一致即拒绝（版本已变化 → 用户重新查看）；
- **用户创建与同意证据同事务**：不存在"已注册但无同意记录"的中间态；
- 没有 checkbox 的提交直接被 schema 拒绝（无"注册即表示同意"的默示同意）。

## 7. 公开法务页面

| 路由 | 内容 |
| --- | --- |
| `/legal` | 当前生效文档索引 |
| `/legal/terms` · `/legal/privacy` · `/legal/rules` · `/legal/prohibited` | 当前生效版本全文 |
| `/legal/[type]?version=N` | 历史版本存档（RETIRED 亦可见，immutable） |
| `/legal/accept` | 重新同意页（consent gate 解除入口） |

- 旧路由 `/privacy`、`/rules` 永久重定向到新路由（不保留第二份会漂移的静态文本）；
- 内容唯一来源是 LegalDocument 表——页面不存在硬编码法务文本；
- 未登录可访问；`GET /api/legal/documents` 提供同源公开 API
  （`Cache-Control: public, max-age=60, stale-while-revalidate=300`
  ——内容不可变所以可缓存，"当前版本指针"最多滞后 60s）。

## 8. 平台规则 / 禁止交易内容范围

与 MASTER_ROADMAP §10 的产品边界一致，不扩大为无法执行的法律百科：

- 禁止：代写/代考作弊、非法金融、违禁品、违规账号交易、
  绕过平台治理的欺诈、利用平台建立资金池；
- 明确资金红线：平台不经手交易资金；禁止"普通商家收款码 + 平台截留 +
  人工转卖家"模式；当前阶段全部为线下面对面支付语义；
- 允许的学习类服务边界（辅导/讲解/答疑/批改/排版/整理）沿用现有产品规则。

## 9. 相关错误码

`LEGAL_ACCEPTANCE_REQUIRED` / `LEGAL_DOCUMENT_NOT_FOUND` /
`LEGAL_DOCUMENT_VERSION_CHANGED` / `LEGAL_DOCUMENT_NOT_CURRENT` /
`LEGAL_DOCUMENT_ALREADY_PUBLISHED`（见 `src/lib/governance/domain-errors.ts`，
HTTP 映射与全局 error taxonomy 一致）。
