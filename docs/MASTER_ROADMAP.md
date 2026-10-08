# Master Roadmap v1.1（产品工程路线唯一权威来源）

> **MASTER_ROADMAP_VERSION = 1.1**
> **CANONICAL_ROADMAP = YES**
> 冻结基线：master @ `be0fd94c92a751c0dd6acd1f417abdd42b6f5751`（2026-09-02，Production Phase 4 合并后）
> 初始冻结：[ADR 0001 — Freeze Master Roadmap v1.0](adr/0001-master-roadmap-v1.md)
> 当前 amendment：[ADR 0002 — Non-Payment Production Completion](adr/0002-non-payment-production-completion.md)（2026-10-01）

---

## 1. Document Contract（文档契约）

本文件是后续产品工程路线的 **canonical roadmap source of truth**。

| 属性 | 值 |
| --- | --- |
| MASTER_ROADMAP_VERSION | `1.1` |
| CANONICAL_ROADMAP | `YES` |
| 冻结日期 | 2026-09-02 |
| 冻结基线 SHA | `be0fd94c92a751c0dd6acd1f417abdd42b6f5751` |

本文件负责：

- Phase 顺序
- Phase 状态
- Gate 定义
- launch blockers
- deferred scope
- backlog policy

其它文档（ARCHITECTURE / SECURITY / PRODUCTION_DEPLOYMENT / OBSERVABILITY / TODO 等）
可以展开实现细节，但**不得与本文件冲突**。

**冲突裁决规则**：若任何文档与本文件在 Phase 顺序、Phase 状态、Gate 状态上不一致，
以本文件为准；技术实现细节仍以对应专项文档为准。
（本文件记录"是否完成、处于哪个 Gate"，专项文档记录"如何实现、如何操作"。）

---

## 2. Current Production State（当前生产状态）

正式记录（路线结构冻结于 2026-09-02；Phase / Gate 状态持续按后续独立验收结果更新——
ROADMAP STRUCTURE FREEZE != PHASE STATUS FREEZE）：

| 阶段 | 名称 | 状态 |
| --- | --- | --- |
| Phase 1 | Object Storage / Sensitive Asset Security | **DONE / MERGED / MASTER-GREEN**（2026-08-28） |
| Phase 2 | Critical-path E2E / Release Gate | **DONE / MERGED / MASTER-GREEN**（2026-08-30） |
| Phase 3A | Production Deployment Foundation（仓库侧） | **DONE / MERGED / MASTER-GREEN / REPO_SIDE_ACCEPTED**（2026-08-30）；`PRODUCTION_DEPLOYMENT_FOUNDATION_ACCEPTED = YES` |
| Phase 3B | Real Production Deployment（真实服务器上线） | **DEFERRED**（外部资源缺口，非代码质量失败） |
| Phase 4 | Observability / Monitoring / Recovery | **DONE / MERGED / MASTER-GREEN / CLOSED**（2026-09-02，经独立验收三轮收口） |
| Phase 5 | Privacy / Agreements / Platform Rules / Data Governance | **DONE / MERGED / MASTER-GREEN / CLOSED**（2026-09-05，PR #8，经多轮独立验收 + post-merge master CI 收口） |
| Phase 6A | Identity / Campus Membership / Verification / RBAC Foundation（Phase 6 第一实施阶段） | **DONE / MERGED / MASTER-GREEN / CLOSED**（2026-09-05，PR #10，经独立验收 Repair 1 + post-merge master CI 收口） |
| Phase 6B | Trust / Risk / Enforcement Foundation（Phase 6 第二实施阶段） | **DONE / MERGED / MASTER-GREEN / CLOSED**（2026-09-07，PR #12，经多轮独立验收 Repair 1–3 + Final Repair + post-merge master CI 收口） |
| Phase 6C | Appeal Lifecycle / Enforcement Completion / Safety Hardening（Phase 6 第三实施阶段） | **DONE / MERGED / MASTER-GREEN / CLOSED**（2026-09-12，PR #16/#17/#18/#19 实施链收口，经独立验收 + post-merge master CI run 34673546585 attempt=1 收口；closure record 见 §5.2） |
| Phase 6 | Identity / Trust / Safety / RBAC / Audit（整体） | **DONE / MERGED / MASTER-GREEN / CLOSED**（2026-09-12，Phase 6A/6B/6C 全部关闭） |
| Phase 7 | Operations Admin Foundation（支付无关运营后台） | **DONE / MERGED / MASTER-GREEN / CLOSED**（2026-09-22，PR #20–#27 实施链收口；canonical master `2b8ba76606d7e0528f5c1fd861c905a502f1d9e5`，post-merge master CI run 35713347538 attempt=1 双绿；closure record 见 §5.3） |
| Phase 8 | Marketplace Lifecycle Hardening | **DONE / MERGED / MASTER-GREEN / CLOSED**（2026-10-02，8A–8F 全部关闭；master = f6ac13d，PR #56 Phase 8F merge 后 post-merge master CI 双绿；权威状态行见下方当前状态表） |
| Phase 9 | Async Jobs / Transactional Outbox / Notifications / Retention | **DONE / MERGED / MASTER-GREEN / CLOSED**（2026-10-05，9A / 9B / 9C-01 / 9C-02 / 9C-03 / 9C-04 全部 CLOSED；final master `e497dcde`，PR #62 merge 后 post-merge master CI run 37302064162 attempt=1 verify/e2e 双绿；Independent Final Acceptance PASS；closure record 见 §5.5） |

Phase 5 code merge reference：`dc6dd13539cd9241d5d660dc606fc0f7e27a11c1`
（PR #8 合并提交——Phase 5 代码范围的固定引用点，**不随 master 前进而改写**，
实时 master 以 git 仓库为准）；
Phase 6A master-green reference：`d1b311c0d1ee1b9a3f78bd30fd28a90742d8bcc3`
（PR #10 合并提交——Phase 6A 代码范围的固定引用点，**不随 master 前进而改写**）；
Phase 6B master-green reference：`d5f8e19151184f7b5ce5660103cc5632f183e9b9`
（PR #12 合并提交——Phase 6B 代码范围的固定引用点，**不随 master 前进而改写**）；
Phase 6C master-green reference：`ed63d20850259ee7bcc6674c8d6836bc5b0a56f9`
（PR #19 合并提交——Phase 6C 代码范围的固定引用点，**不随 master 前进而改写**）；
Phase 7 canonical baseline：`2b8ba76606d7e0528f5c1fd861c905a502f1d9e5`
（PR #27 合并提交——Phase 7 代码范围的固定引用点，**不随 master 前进而改写**）；
Phase 6B Closure Recovery current master reference：`97f53cd3494b24854a56b19e0418d50a5b5efeb6`
（PR #14 合并提交——RBAC bootstrap 并发修复的固定引用点，**不随 master 前进而改写**；
两者语义不同：d5f8e19 = 6B core code merge，97f53cd = closure recovery merge）；
上一记录点：`be0fd94c92a751c0dd6acd1f417abdd42b6f5751`，Phase 4 合并提交、
亦为 Roadmap v1.0 冻结基线（历史冻结事件记录保留于 §1，不随 master 前进改写）。

同时保持：

- `PHASE_3B_REAL_DEPLOYMENT = DEFERRED`
- `PRODUCTION_LAUNCH_BLOCKED = TRUE`

**绝不声称 `PRODUCTION_READY = TRUE`。** 本仓库当前状态是"具备可部署的仓库侧能力"，
不是"已具备公开生产运营资格"（见 §9）。

当前测试基线（来自最近一次成功的 master CI，非本地估算；source = master CI
37302064162，Phase 9 Final Closure merge
`e497dcde73a138415e5546222ab97c3293813be3`，2026-10-05，attempt = 1）：
444 个测试文件 / 4028 个测试全部通过、0 failed（CI 中真实 PostgreSQL / Redis / MinIO
集成测试全部真实执行，无环境门控 skip），覆盖率 lines 89.31% / branches 86.02% /
functions 90.68% / statements 89.31%（四项 ≥ 80% 硬门槛 PASS）；
Playwright E2E 关键链路 93/93 全绿、0 flaky / 0 failed。
历史基线：Phase 7 Final Closure 时点 353 文件 / 2840 tests / E2E 72 条 /
coverage 88.94 / 85.57 / 89.44 / 88.94（master CI 35713347538，merge
`2b8ba76606d7e0528f5c1fd861c905a502f1d9e5`）——仅作历史记录，非当前基线；
Closure Recovery 时点 243 文件 / 1580 tests / E2E 36 /
coverage 85.72 / 83.50 / 84.76 / 85.72（master CI 34132745423，merge
`97f53cd3494b24854a56b19e0418d50a5b5efeb6`）——仅作历史记录，非当前基线。
最新数字始终以最近一次成功的 master CI 为准（见 docs/TODO.md「当前测试基线」）。

---

## 3. GATE A — Engineering Reliability（工程可靠性门）

Phase 4 合并收口后，**仓库侧工程基础视为已验收**（GATE A PASS）：

- 对象存储与敏感资产安全（Phase 1）
- 关键链路 E2E 与 release gate（Phase 2）
- 仓库侧生产部署基础（Phase 3A）
- 可观测性 / 监控 / 恢复基础（Phase 4）

Phase 3B 保持 DEFERRED，原因不变：真实外部生产基础设施（服务器/域名/DNS 等）
当前不提供——这是外部资源缺口，不是代码质量失败。
**3B 的重开时机在 GATE B 之后**（见 §5.8），且 GATE A 不改变
`PRODUCTION_LAUNCH_BLOCKED = TRUE`。

---

## 4. Phase 3A / 3B Boundary（3A 与 3B 的边界）

重新明确二者边界，防止"仓库侧完成"被误读为"已上线"：

- **Phase 3A = repo-side production deployment foundation**：
  Docker 打包、Compose 拓扑、Caddy/TLS 模板、env 校验、迁移纪律、备份/恢复/回滚
  工具链、CI release gates、branch protection——全部可以在仓库内完成并验证的部分。
  **状态：DONE。**
- **Phase 3B = real external production deployment**：
  在真实外部基础设施上实际执行部署并逐项验证。**状态：DEFERRED，未完成。**

Phase 3B 的主要 external gates（重开时逐项执行、逐项留证）：

1. authorized production Linux server
2. Docker / Compose runtime
3. SSH administration
4. domain
5. DNS
6. HTTPS / ACME（真实证书）
7. HTTP → HTTPS 强制重定向验证
8. production PostgreSQL 部署
9. production Redis 验证
10. production S3 / MinIO 生产部署
11. independent offsite backup（独立异地备份目标）
12. real backup（真实执行）
13. real restore drill（真实执行）
14. restart / reboot test
15. rollback test（不可变 SHA 镜像回滚实测）
16. production-origin smoke（公网域名冒烟）
17. authenticated smoke（登录态生产冒烟）
18. public asset verification
19. private asset verification
20. network exposure verification（仅 80/443 公开）
21. real release SHA verification（`/api/health` release == 部署 SHA）
22. external compliance prerequisites where applicable
    （ICP 备案/公安联网备案/域名实名等，以真实凭证为准）

> **重要（Phase 3B 顺序硬约束）**：
> - Phase 5–11 完成不会自动把 3B 标记为 DONE。
> - **GATE B PASS 是重开 3B 的前置**（见 §5.8）；重开后必须实际执行上述
>   external gates 并通过验收，3B 才算完成/关闭。
> - **Phase 12 Alpha 的硬前置是 Phase 3B 已完成/关闭**——3B 仍处 DEFERRED 时
>   Phase 12 不得开始。
> - Phase 12–24 不能作为 3B external deployment completion 的替代证据。

---

## 5. Frozen Roadmap（冻结的主线路线）

以下 Phase 顺序正式冻结。编号不得漂移，不得在中间插入新 Phase
（新想法默认进 Backlog，见 §11）。

| 序列 | 名称 | 状态 |
| --- | --- | --- |
| Phase 1 | Object Storage / Sensitive Asset Security | DONE / MERGED / MASTER-GREEN |
| Phase 2 | Critical-path E2E / Release Gate | DONE / MERGED / MASTER-GREEN |
| Phase 3A | Production Deployment Foundation | DONE / MERGED / MASTER-GREEN |
| Phase 3B | Real Production Deployment | **DEFERRED**（GATE B 后重开） |
| Phase 4 | Observability / Monitoring / Recovery | DONE / MERGED / MASTER-GREEN / CLOSED |
| **GATE A** | Engineering Reliability | **PASS**（Phase 4 收口即达成） |
| Phase 5 | Privacy / Agreements / Platform Rules / Data Governance | **DONE / MERGED / MASTER-GREEN / CLOSED**（2026-09-05；PR #8 经多轮独立验收后合并，post-merge master CI 双绿） |
| Phase 6 | Identity / Trust / Safety / RBAC / Audit | **DONE / MERGED / MASTER-GREEN / CLOSED**（2026-09-12，6A/6B/6C 全部关闭，见 §5.2） |
| Phase 7 | Operations Admin Foundation | **DONE / MERGED / MASTER-GREEN / CLOSED**（2026-09-22，PR #20–#27 实施链收口，见 §5.3） |
| Phase 8 | Marketplace Lifecycle Hardening | **DONE / MERGED / MASTER-GREEN / CLOSED**（2026-10-02，8A–8F 全部关闭；master = f6ac13d，PR #56 Phase 8F merge 后 post-merge master CI 双绿） |
| Phase 9 | Async Jobs / Transactional Outbox / Notifications / Retention | **DONE / MERGED / MASTER-GREEN / CLOSED**（2026-10-05，9A / 9B / 9C-01 / 9C-02 / 9C-03 / 9C-04 全部 CLOSED，PR #57–#62 实施链收口；final master `e497dcde`，post-merge master CI run 37302064162 attempt=1 verify/e2e 双绿；Independent Final Acceptance PASS；closure record 见 §5.5） |
| Phase 10 | Analytics / Marketplace Liquidity / Risk / Config Center / Feature Flags | **IN_PROGRESS**（10A–10G 已合并；10G post-merge master CI run 37751166929 双绿；剩余运营界面及 Phase 10 整体验收未完成） |
| Phase 11 | Pilot Readiness（11A Account Lifecycle / 11B Pilot UX / 11C Pilot Ops） | NOT_STARTED |
| **GATE B** | Pilot Ready | NOT_REACHED（通过后才重开 Phase 3B） |
| Phase 3B（重开） | Real Production Deployment | DEFERRED |
| Phase 12 | Controlled Single-Campus Alpha | NOT_STARTED |
| Phase 13 | Closed Campus Beta | NOT_STARTED |
| Phase 14 | Controlled Single-Campus Pilot | NOT_STARTED |
| **GATE C** | Product Validation | NOT_REACHED（PASS 才解锁支付 Phase） |
| Phase 15 | Payment Domain Model | NOT_STARTED |
| Phase 16 | Licensed Payment Provider Integration | NOT_STARTED |
| Phase 17 | Refund / Split / Platform Fee / Immutable Ledger | NOT_STARTED |
| Phase 18 | Settlement / Reconciliation / Payment Risk | NOT_STARTED |
| Phase 19 | Payment Operations Console | NOT_STARTED |
| **GATE D** | Commercial Ready | NOT_REACHED |
| Phase 20 | Monetization Experiments | NOT_STARTED |
| Phase 21 | Campus Launch Playbook | NOT_STARTED |
| Phase 22 | Multi-Campus Architecture Validation | NOT_STARTED |
| Phase 23 | Second-Campus Pilot | NOT_STARTED |
| Phase 24 | Scaled Multi-Campus Operations | NOT_STARTED |

### 5.1 Phase 5 — Privacy / Agreements / Platform Rules / Data Governance

范围包括：user agreement、privacy policy、platform rules、prohibited transaction
rules、agreement/policy versioning、acceptance records、data classification、
retention、deletion、anonymization、account deletion、data export、
privacy requests、legal hold、dispute hold、sensitive-data governance。

**Closure record（2026-09-05）**：

- Status：**DONE / MERGED / MASTER-GREEN / CLOSED**
- Merge：PR #8（<https://github.com/ljjnb666-nb/Campus-Marketplace/pull/8>），
  merge commit `dc6dd13539cd9241d5d660dc606fc0f7e27a11c1`（Phase 5 code merge reference）
- Post-merge master CI：run 33943242174 —— verify = success、e2e = success、attempt = 1
- Final verification baseline：226 test files / 1322 tests；coverage
  83 / 81.76 / 82.18 / 83；Playwright critical paths = 33
- Independent review：Initial review → Repair 1 → Repair 2 → Repair 3 →
  Repair 4 → Final review **PASS**
- 权威细节文档：[LEGAL_GOVERNANCE.md](LEGAL_GOVERNANCE.md)、
  [DATA_GOVERNANCE.md](DATA_GOVERNANCE.md)、[PRIVACY_OPERATIONS.md](PRIVACY_OPERATIONS.md)
- **LEGAL_REVIEW_REQUIRED = TRUE**：Phase 5 CLOSED 的含义是工程治理范围完成；
  production legal text remains subject to formal legal review——不构成正式法律意见，
  不声称 fully compliant / PIPL compliant / GDPR compliant。

### 5.2 Phase 6 — Identity / Trust / Safety / RBAC / Audit

范围包括：Campus 升级为一等领域实体、CampusMembership、campus verification
lifecycle、verification policy/versioning、admin roles、permissions、RBAC、
sensitive asset access audit、AdminAuditLog、suspension / reinstatement、
trust profile foundation、risk state、enforcement、appeal foundation、
admin security foundation。

**Phase 6A Closure record（2026-09-05）**：

- Status：**DONE / MERGED / MASTER-GREEN / CLOSED**
- Merge：PR #10（<https://github.com/ljjnb666-nb/Campus-Marketplace/pull/10>），
  merge commit `d1b311c0d1ee1b9a3f78bd30fd28a90742d8bcc3`（Phase 6A master-green reference）
- Final reviewed PR head：`c850acae12f6bec31804f7be3f53355051364b4e`
  （pre-merge exact-head PR CI run 33965801562：verify = success、e2e = success、attempt = 1）
- Post-merge master CI：run 33968202720 —— verify = success、e2e = success、attempt = 1
- Final independent review：Initial review → Repair 1 → Final review PASS →
  merge → post-merge master CI PASS（`PRODUCTION_PHASE_6A_POST_MERGE_REVIEW = PASS`）
- Final scope（6A foundation，简洁记录）：Campus first-class foundation、
  CampusMembership、verification policy/version lifecycle、verification membership
  integrity、RBAC foundation、membership-bound campus authorization、
  actor/target subject serialization、legacy admin authorization convergence、
  sensitive asset authorization + audit、AdminAuditLog foundation
- Final security invariants：
  `CAMPUS_ACTIVE_MEMBERSHIP_REQUIRED = PASS`、
  `VERIFICATION_MEMBERSHIP_INTEGRITY = PASS`、
  `ACTOR_AUTHORIZATION_SERIALIZATION = PASS`、
  `DUAL_AUTH_SOURCE_CONVERGENCE = PASS_FOR_PHASE_6A`；
  `User.role` authorization callsites = 0（字段保留，仅限 display / session
  compatibility / seed / migration/bootstrap 用途，未被删除）
- Known non-blocking follow-up（Phase 6A 收口时点历史快照，
  `NON_BLOCKING / NO_FAIL_OPEN`，当时标记
  `DEFERRED_TO_PHASE_6B_OR_PHASE_7`）：
  `USER_STATUS_ROLE_ASSIGNMENT_RACE`——`toggleUserStatus` 的 privileged-target
  检查与 role assignment/revocation 尚未共享同一个 target subject serialization
  boundary。**后续状态：CLOSED_IN_PHASE_6B / PASS**——Phase 6B 已通过共享
  sorted `USER:target` governance subject serialization 关闭账号停用与
  角色授予/撤销竞态（真实 PostgreSQL 双方向竞态回归锁定）。

**Phase 6A 之后（historical state at Phase 6A closure）**：

- `PHASE_6A = DONE / MERGED / MASTER-GREEN / CLOSED`
- `PHASE_6 = IN_PROGRESS`
- 以下为 Phase 6A 收口时点的历史快照（当时 `PHASE_6B = NOT_STARTED`；
  6B/6C 预留 trust profile、risk state、enforcement、appeal、suspension
  产品化、完整 admin 角色 UI（Phase 7））——该表述仅是历史记录，
  Phase 6B 现已关闭（见下方 Closure record），不得解读为当前状态。

**Phase 6B 进度快照（2026-09-05，historical snapshot）**：

- 该时点 `PHASE_6B = IMPLEMENTED / PENDING_INDEPENDENT_REVIEW`
  （PR #12，Draft）。此为实现完成时点的历史记录；当前状态见下方
  Closure record，不构成 current state。

**Phase 6B Closure record（2026-09-07）**：

- Status：**DONE / MERGED / MASTER-GREEN / CLOSED**
- Merge：PR #12（<https://github.com/ljjnb666-nb/Campus-Marketplace/pull/12>），
  merge commit `d5f8e19151184f7b5ce5660103cc5632f183e9b9`（Phase 6B master-green reference）
- Final reviewed PR head：`90630a43de04478b93969d2899d63d885b352a9f`
  （pre-merge exact-head PR CI run 34110863736：verify = success、
  e2e = success、attempt = 1）
- Post-merge master CI：run 34113125694 —— event = push、branch = master、
  verify = success、e2e = success、**attempt = 1**
- Final independent review：Initial implementation → Repair 1 → Repair 2 →
  Repair 3 → Final Repair（canonical-missing fail closed）→
  **Final review PASS** → merge → post-merge master CI PASS
  （`PRODUCTION_PHASE_6B_FINAL_REVIEW = PASS`、
  `PRODUCTION_PHASE_6B_POST_MERGE_REVIEW = PASS`；
  `ENGINEERING_BLOCKERS = 0`、`TEST_BLOCKERS = 0`、
  `MERGE_HYGIENE_BLOCKERS = 0`、`REPAIR_REQUIRED = NO`）

Final scope（6B foundation，精炼记录）：central Trust Snapshot、RiskState、
RiskFlag、EnforcementAction、marketplace capability gate、
account suspension / reinstatement、campus membership suspension / reinstatement、
governance subject-lock serialization、effective verification、
report-risk deterministic reconciliation。
**`TRUST SIGNAL != RISK STATE != ENFORCEMENT`。**

Trust / risk / enforcement invariants（closure 时最终合同）：

- `NO_OPAQUE_SCORING = TRUE`（无任何综合分/自动判定）；
  `CREDIT_SCORE = LEGACY_DISPLAY_SIGNAL`（绝不作为 enforcement source）；
  `REPORT_AUTO_PUNISHMENT = DISABLED`（举报创建仅记录信号，零自动处罚）
- **Effective verification final contract**：
  `EFFECTIVE_VERIFIED = canonical UserVerification.status == VERIFIED
  AND bound CampusMembership.status == ACTIVE`；
  `canonical UserVerification missing => UNVERIFIED`；
  `User.verificationStatus = NON_AUTHORITATIVE_FOR_TRUST`
  （仅 display/session/bootstrap/migration 兼容投影；
  **无任何 legacy fallback VERIFIED**）
- **Trust isolation**：`PUBLIC TRUST = public-safe only`；
  `GLOBAL INTERNAL = GLOBAL audit.read`（全部 membership / risk states /
  全平台信号）；`CAMPUS INTERNAL = audit.read@campus + target membership ∈
  {ACTIVE, SUSPENDED} + campus-local risk/report signals`；
  `cross-campus internal risk/report leakage = CLOSED`
- **Risk / enforcement 分层**：`RiskState = NORMAL / WATCH / RESTRICTED`；
  `RESTRICTED = soft marketplace restriction`（仅禁止开始新 marketplace 活动）；
  `User.status = SUSPENDED = hard account-level enforcement`（二者不混同）；
  report creation → signal only → **NO automatic restriction/suspension**
- **Marketplace capability gate**：new marketplace activity requires
  account ACTIVE + applicable CampusMembership ACTIVE +
  applicable RiskState != RESTRICTED；
  新义务 participant invariant：**ALL CAMPUS OBLIGATION PARTICIPANTS must
  have ACTIVE CampusMembership at obligation creation**；
  existing obligation fulfillment 不受新活动 gate 误伤
  （EXISTING_OBLIGATION_PRESERVATION）
- **Concurrency closure**（真实 PostgreSQL；barrier = exact loser PID /
  exact governance lock evidence，非 sleep 定序；`NO_40P01 = PASS`）：
  `USER_STATUS_ROLE_ASSIGNMENT_RACE = CLOSED`、
  `ACTOR_ERASURE_VS_ENFORCEMENT = SERIALIZED`、
  `RISK_RESTRICT_VS_RESTORE = SERIALIZED`、
  `MEMBERSHIP_SUSPEND_VS_LISTING_CREATE = SERIALIZED`、
  `REPORT_REVIEW_TRANSITION = ROW_LOCK_SERIALIZED`
- **Phase 6B final reviewed baseline**（Final Repair 验证轮）：
  243 test files / 1567 tests（1463 passed + 104 env-gated skip）；
  coverage 83.33 / 82.36 / 82.27 / 83.33；真实 PostgreSQL 集成：
  Phase 6B 27 条（Phase 6A 17 条保留）；Playwright 36/36 × 3
  （workers=2、retry=0）；Mimosa NEW_HIGH = 0 / NEW_CRITICAL = 0
- Known non-blocking（`NON_BLOCKING / TEST_INFRA_DEBT`，非生产授权 fail-open）：
  ① tests/ops/ops-scripts.test.ts 本地高负载偶发 120s timeout（isolated run
  PASS；exact-head/post-merge CI PASS）——唯一仍开放债务。
  原 ② ensureCampusMemberships bootstrap 竞态已关闭，见下方 Closure Recovery，
  不列为开放债务

**Closure Recovery（2026-09-07）**：

- Trigger：PR #13 canonical docs merge 后 master CI attempt=1 红灯——
  failed master `131d54c38484a92ba905daa4548a27105822ec5e`、failed CI
  run 34124977074（verify = failure、e2e = skipped、attempt = 1，
  **INITIAL DOCS POST-MERGE CI = FAILED，保留为历史证据、未 rerun**）。
  根因 = `ensureCampusMemberships` snapshot→create 真实并发缺陷
  （Prisma P2002 on (userId, campusId)），非 GitHub 基础设施故障
- Recovery：PR #14，reviewed head `423bfd0852511aa6aae4d52398434a32e6d814e8`，
  merge commit `97f53cd3494b24854a56b19e0418d50a5b5efeb6`
  （Closure Recovery current master reference，与 6B core merge reference
  d5f8e19 语义不同）
- 修复语义：snapshot→blind-create 收敛为 attempt create once → inspect
  expected conflict → re-read canonical DB truth → converge or rethrow。
  P2002（预期 (userId,campusId) 目标精确判定）→ exact membership 复查：
  赢家已写入 = 幂等成功、缺失 = rethrow；P2003 → user/campus referent 复查：
  消失 = stale snapshot no-op、仍在 = rethrow；
  NO retry loop / NO sleep ordering / NO membership status rehabilitation
  （bootstrap 不绕过 membership 状态机）；并新增确定性真实 PG 并发回归
  （Phase 6A 集成 17 → 19）
- SUPERSEDED MASTER EVIDENCE：Recovery post-merge master CI run 34132745423
  —— event = push、branch = master、verify = success、e2e = success、
  **attempt = 1**
- Old failed CI rerun：**NO**

**Phase 6B 之后（historical snapshot at Phase 6B closure）**：

- `PHASE_6B = DONE / MERGED / MASTER-GREEN / CLOSED`
- 以下为 Phase 6B 收口时点的历史快照（当时 `PHASE_6 = IN_PROGRESS`、
  `PHASE_6C = NOT_STARTED`；6C 预留 appeal 完整生命周期、enforcement
  completion / safety hardening、hard-suspension 隐私例外路径、受限/停用
  用户的 listing / enforcement policy completion）——该表述仅是历史记录，
  6C 现已关闭（见下方 Closure record），不得解读为当前状态。

**Phase 6C Closure record（2026-09-12）**：

- Status：**DONE / MERGED / MASTER-GREEN / CLOSED**
- 实施链（四段拆分，全部经独立验收 + exact-head CI 后合并）：
  - PR #16（Phase 6C-1A，Provenance / enforcement seq foundation）：
    merge commit `c4ea90802972123d2d89ffc0ff5b77f3736246f8`
  - PR #17（Phase 6C-1B，Appeal domain）：merge commit
    `f2bff2089f88ba336f785acf773250e2eafff226`
  - PR #18（Phase 6C-2，Appeal HTTP surface）：merge commit
    `9cb94700dc08db443fe2492b4caee9241351420c`
  - PR #19（Phase 6C-3，Marketplace capability + dispute/support 收口）：
    final merge commit `ed63d20850259ee7bcc6674c8d6836bc5b0a56f9`
    （Phase 6C master-green reference）
- Final reviewed PR head：`640121baf0e5aa8a8e630734ecc1873679574358`
- Post-merge master CI：run 34673546585 —— event = push、branch = master、
  verify = success、e2e = success、**attempt = 1**
- Final scope（精炼记录）：enforcement provenance / seq causal ordering、
  appeal 完整生命周期（含 HTTP self-service surface）、marketplace capability
  taxonomy + 参与方限制、dispute / support 运营队列收口、
  rental dispute convergence
- **`PHASE_6C = DONE / MERGED / MASTER-GREEN / CLOSED`**

**Phase 6 Closure（2026-09-12）**：

- `PHASE_6A = DONE / MERGED / MASTER-GREEN / CLOSED`
- `PHASE_6B = DONE / MERGED / MASTER-GREEN / CLOSED`
- `PHASE_6C = DONE / MERGED / MASTER-GREEN / CLOSED`
- **`PHASE_6 = DONE / MERGED / MASTER-GREEN / CLOSED`**

### 5.3 Phase 7 — Operations Admin Foundation

**此阶段必须在在线支付之前完成；同时它不依赖真实在线支付。**

范围包括（支付无关运营能力）：operations dashboard、user management、
campus verification review、products / errands / services / rentals moderation、
reports、moderation cases、enforcement actions、appeals、disputes、
support tickets、operations queues、SLA / dueAt、audit visibility、
campus configuration、system / operational overview。

**重要**：未来的支付运营能力将**扩展本阶段建立的运营后台**，
而不是另建一套互不相关的第二个 admin console。

**Phase 7 Final Closure Record（2026-09-22）**：

- Status：**DONE / MERGED / MASTER-GREEN / CLOSED**（canonical Phase 7
  code baseline：`2b8ba76606d7e0528f5c1fd861c905a502f1d9e5`，PR #27 合并提交）
- 实施链（八个切片，全部经独立验收 + exact-head CI 后合并）：

  | 切片 | PR | Merge commit |
  | --- | --- | --- |
  | 7A Appeals | #20 | `f2d5aeaa644f9b77e1afea24abbecabc89b4dea9` |
  | 7B Roles | #21 | `f5a29f2caf9c159d5a47a8b76f1e42f74b5cef96` |
  | 7C Moderation | #22 | `caf8c22d650d70f738e5ce3056d1c187f6d17c50` |
  | 7D Visibility | #23 | `85fcee88431a99585911803f7d78eb083eb90fe0` |
  | 7E Reports / Cases | #24 | `6aeda72d1f2d91ab4f59b8b1a0b9db4fa90f32b0` |
  | 7F User Verification Ops | #25 | `585c94ba86b1488478146b0995a94503cc1b4dfc` |
  | 7G Disputes / Support | #26 | `8a0355cc7fabe6c8652983dc299e83161cd441b5` |
  | 7H Ops Overview / Campus Admin | #27 | `2b8ba76606d7e0528f5c1fd861c905a502f1d9e5` |

- Post-merge master CI：run 35713347538 —— event = push、branch = master、
  **attempt = 1**、verify = SUCCESS（353 files / 2840 tests）、e2e = SUCCESS
  （72 passed）、coverage 88.94 / 85.57 / 89.44 / 88.94
- **Capability closure（`PHASE_7_CANONICAL_CAPABILITY_CLOSURE = 18 / 18`）**：
  TOTAL = 18、COMPLETE = 18、PARTIAL = 0、FOUNDATION_ONLY = 0、
  LEGACY_ONLY = 0（within canonical Phase 7 scope）、MISSING = 0——
  operations dashboard、user management、campus verification review、
  product / errand / service / rental moderation、reports、moderation cases、
  enforcement actions、appeals、disputes、support tickets、operations queues、
  SLA / dueAt、audit visibility、campus configuration、
  system / operational overview
- Legacy admin audit：`/admin`、`/admin/users`、`/admin/verifications`、
  `/admin/reports`、`/admin/products`、`/admin/errands`、`/admin/services`
  均已退役为 `/governance/*` redirect——canonical governance operations
  console = `/governance`，**不存在第二套 active Phase 7 governance
  authority**；剩余 legacy maintenance surface：`/admin/categories`、
  `/admin/keywords`（OUTSIDE Phase 7 canonical 18-capability scope、
  NON_BLOCKING，见 [BACKLOG.md](BACKLOG.md)
  P7-BACKLOG-LEGACY-MAINT-01）
- Closure debts（详见 [BACKLOG.md](BACKLOG.md)）：
  `P7-CLOSURE-DEBT-01 = CLOSED`（Phase 6C RACE-1 test start-order
  nondeterminism；修复 = deterministic lock-holder signal 先于竞争 waiter
  启动；production bug = NO EVIDENCE）；
  `P7_UI_DUPLICATE_DOM_01 = DOWNGRADED_WITH_PROOF`（transient hidden
  streamed/hydration shell；PRODUCT_BUG = NO EVIDENCE；
  USER_VISIBLE_DUPLICATION = NO；release test contract = a11y exact page
  h1 = 1 + raw DOM exact page h1 = 1 before strict interaction；
  框架行为仍存在，非"Next.js bug fixed"——temp-worktree A/B 实测
  16.3.3 ≡ 16.3.5，依赖保持冻结）；
  `P7-DEBT-E2E-SETUP-01`（NON_BLOCKING；candidate phase = Phase 8；
  review_at = Full-System Adversarial Audit / pre-Phase 8）、
  `P7-DEBT-E2E-LOAD-01`（NON_BLOCKING；candidate phase = Later；
  review_at = Full-System Adversarial Audit）

**Phase 7 之后（development workflow guard，非新增 canonical Phase）**：

- `PHASE_7 = DONE / MERGED / MASTER-GREEN / CLOSED`
- `NEXT = FULL-SYSTEM ADVERSARIAL AUDIT`（仅 audit PASS 后才进入
  Phase 8；Master Roadmap Phase 顺序不变）

### 5.4 Phase 8 — Marketplace Lifecycle Hardening

范围包括：

- Listing lifecycle：`DRAFT → ACTIVE → RESERVED → SOLD / EXPIRED / SUSPENDED / REMOVED`
- reservation lifecycle、reservation timeout / release
- meetup、MeetupPoint、no-show
- exceptional order states、dispute-aware transaction lifecycle
- review integrity、retaliation-resistant review compatibility
- messaging safety、Block User、message reporting、spam / abuse controls

目标：让交易市场在**异常真实用户行为**下依然安全且正确，而不只覆盖 happy path。

### 5.5 Phase 9 — Async Jobs / Transactional Outbox / Notifications / Retention

范围包括：transactional outbox、background jobs、retry、backoff、lease、
dead-letter semantics、idempotency、scheduled expiration、reservation cleanup、
retention cleanup、risk scans、statistics jobs。

统一通知域：`Domain Event → Notification → In-App / Email / Web Push / 未来外部渠道`。

其中 **Email 必须作为正式 transactional delivery channel**，至少能够承载后续
Phase 11A 的邮箱所有权验证、密码重置、安全事件提醒等账号安全邮件；不得为找回密码
临时旁路出第二套不可审计的邮件发送路径。营销邮件不属于该硬前置范围。

**架构约束：不引入 Kafka，不引入不必要的微服务。**

**Closure record（2026-10-05）**：

- Status：**DONE / MERGED / MASTER-GREEN / CLOSED**
- 实施链（六段拆分，全部经独立验收 + exact-head CI 后合并）：

  | 切片 | PR | Merge commit |
  | --- | --- | --- |
  | 9A Async core / Outbox | #57 | `8752a248be9dc99d300a54ec8110d22e10e644e7` |
  | 9B Unified notifications / transactional email | #58 | `e774e1c2b79b4948f6181bfbf53d0d7580851133` |
  | 9C-01 Hold-safe cleanup | #59 | `0818c9a0f53924ee2ee6b9f5bd3ecdcbdcee9551` |
  | 9C-02 Errand deadline scheduler | #60 | `b870c0c0f7a5075ea702ada2f0ede4765046a5c6` |
  | 9C-03 Durable async data export | #61 | `0d075141e6d373d82f1149b8f398e4c0f5b3dda6` |
  | 9C-04 Retention / tombstones / ops reconcile | #62 | `e497dcde73a138415e5546222ab97c3293813be3`（Phase 9 final master） |

- Post-merge master CI：run 37302064162 —— event = push、branch = master、
  **attempt = 1**、verify = SUCCESS（444 files / 4028 tests）、
  e2e = SUCCESS（93 passed）
- Final baseline：**444 test files / 4028 tests**、Playwright E2E **93/93**、
  **0 flaky / 0 failed**
- Independent Final Acceptance：**PASS**
  （`ENGINEERING_BLOCKERS = 0`、`TEST_BLOCKERS = 0`、`RUNTIME_BLOCKERS = 0`、
  `REPO_SIDE_ACCEPTED = YES`）
- Closure scope summary（精炼记录，非实现文档复制）：
  - 9A：durable PostgreSQL AsyncJob、lease / fencing、retry / backoff、
    DEAD_LETTER、transactional Outbox、reservation expiry
  - 9B：canonical Notification domain、In-App + EMAIL、transactional delivery、
    provider idempotency、crash/retry safety、erasure race safety
  - 9C-01：DataHold-aware cleanup
  - 9C-02：errand deadline scheduler、durable one-shot intents
  - 9C-03：durable async DATA_EXPORT、private artifact、
    same-origin authorized download、TTL cleanup、dead-letter convergence
  - 9C-04：dedupe-safe terminal tombstones、NotificationDelivery PII retention、
    dead-letter reconcile、ops snapshot、single maintenance cadence owner
- Final invariants（closure 时最终合同）：
  `DURABLE_QUEUE_AUTHORITY = POSTGRESQL`、`TRANSACTIONAL_OUTBOX = PASS`、
  `ASYNC_JOB_DEDUPE_IDENTITY_PRESERVED = PASS`、
  `NOTIFICATION_SINGLE_WRITE_AUTHORITY = PASS`、
  `EMAIL_DELIVERY_IDEMPOTENCY = PASS`、
  `SCHEDULED_DOMAIN_INTENT_DURABLE = PASS`、
  `DATA_EXPORT_ASYNC_DURABLE = PASS`、`DATA_HOLD_SAFE_CLEANUP = PASS`、
  `TERMINAL_RETENTION_BOUNDED = PASS`、
  `DEAD_LETTER_NOT_SILENTLY_DELETED = PASS`、
  `OPS_SURFACE_NO_SECRET = PASS`、`SINGLE_MAINTENANCE_CADENCE_OWNER = PASS`
- 权威细节文档：[PHASE9_OPERATIONS.md](PHASE9_OPERATIONS.md)（运行合同 / 运维手册）、
  [DATA_GOVERNANCE.md](DATA_GOVERNANCE.md)、[PRIVACY_OPERATIONS.md](PRIVACY_OPERATIONS.md)
- 边界（不变）：Phase 9 CLOSED **不代表生产上线**——
  `PHASE_3B_REAL_DEPLOYMENT = DEFERRED`、`PRODUCTION_LAUNCH_BLOCKED = TRUE`、
  Phase 10 = NOT_STARTED 均保持不变

### 5.6 Phase 10 — Analytics / Marketplace Liquidity / Risk / Config Center / Feature Flags

范围包括：business event analytics、analytics event versioning、
marketplace liquidity metrics、search zero-result metrics、supply/demand gaps、
listing → conversation conversion、conversation → order conversion、
order completion、time to first interaction、active listings、north-star metric、
RiskSignal、simple rule-based Risk Engine、Feature Flags、Campus Config、
kill switches、maintenance modes、read-only mode、
disable new orders / listings / messages 等开关。

Feature Flags / Config Center 的生产合同至少要求：

- **server-authoritative**：前端 flag 只影响体验，不得成为授权或业务不变量边界；
- **audited**：修改人、时间、scope、旧值/新值可审计；
- **scoped**：至少支持 GLOBAL / CAMPUS，未来 cohort/percentage rollout 可扩展；
- **fail-safe**：读取异常时必须有明确安全默认值，不允许隐式 fail-open；
- **kill switches**：至少能控制注册、新 listing、新订单、新会话/消息、Meetup、
  dispute initiation、maintenance mode、read-only mode 及 campus-scoped disable；
- flag 不能绕过 RBAC、ownership、account lifecycle、marketplace capability gate、
  order/listing state machine 等 canonical authority。

**架构约束：Analytics 与 Audit 必须保持为分离的概念。**

**Phase 10 status correction（2026-10-08）**：10A（#70）、10B（#71）、10C-1（#72）、10C-2（#73）、10D（#74）、10E（#75）、10F（#76）、10G（#77）已按独立 PR 实施合并；10G 精确 master `b4567fcdd356c3b93929b03818aaa6887609a911` 的 post-merge CI run 37751166929 verify/e2e 双绿。Phase 10 保持 **IN_PROGRESS**，不得因为 10G Feature Flags UI CLOSED 而关闭整个 Phase 10。10H Runtime Config UI 仍待独立 PR 验收及 master-green 收口。

### 5.7 Phase 11 — Pilot Readiness

Phase 11 保持一个 canonical top-level Phase，不改变冻结编号；按实施职责拆为
**11A / 11B / 11C 三个 implementation slices**。

#### Phase 11A — Account Lifecycle & Session Security

目标：补齐普通用户账号恢复与会话安全，使身份系统不仅“能登录/能停用”，还具备
生产级 credential recovery、session revocation 与 privileged-account protection。

至少包括：

- 邮箱所有权验证：发送/重发、TTL、单次使用、反枚举、rate limit；
- forgot-password / reset-password：opaque random token、服务端仅保存 hash、
  TTL、单次消费、统一安全响应，不暴露账号是否存在；
- authenticated change-password：必须验证当前密码，新旧凭据不得等价；
- session/device management：当前/近期会话可见，支持 revoke-one、
  revoke-others、revoke-all；
- **session revocation authority**：不得只依赖等待 JWT `maxAge` 到期；
- reset/change password 后按明确策略失效旧会话，其中 reset 必须使 reset 前会话失效；
- login / credential change / reset / session revoke 的 security-event records，
  严禁记录明文密码、raw reset token、JWT；
- recovery abuse controls：至少覆盖 account/email/IP 维度的限流与防邮件轰炸；
- privileged governance accounts 必须在 Pilot 前具备更强认证策略，
  优先 MFA / second factor，不得仅依赖普通用户同等级密码保护；
- 用户可见安全状态、会话状态、错误提示统一使用中文产品文案，
  不直接暴露 raw enum / machine error code。

实现必须复用 Phase 6 身份/RBAC/治理 authority、Phase 9 notification/email delivery；
不得另建割裂的第二套 auth、audit 或 account lifecycle 系统。

#### Phase 11B — Pilot UX / Onboarding / Mobile Critical Paths

范围包括：mobile-first UX、~390x844 移动视口下的关键流程、onboarding、
first listing、first contact、first order、empty states、search usability、
seed content、cold-start plan、help/support entry、safety messaging、
campus announcement/configuration、invite-only capability。

#### Phase 11C — Pilot Operations Closure

范围包括：pilot operational readiness、账号安全运维入口、关键安全/支持升级路径、
feature-flag / kill-switch 操作演练、support / incident escalation、试点前 smoke
与 operator runbook 收口。

**本阶段不要求在线支付。Phase 11 完成不代表 Payment Ready。**

### 5.8 GATE B — Pilot Ready

真实试点部署之前，至少要求：

- governance baseline（Phase 5）
- campus verification（Phase 6）
- moderation / report handling（Phase 6–7）
- operations admin（Phase 7）
- dispute / support flow（Phase 7–8）
- notification foundation（Phase 9），并具备 account-security transactional email delivery
- analytics（Phase 10）
- risk controls（Phase 10）
- feature flags / kill switches（Phase 10）
- password recovery / password change（Phase 11A）
- explicit session revocation / revoke-all（Phase 11A）
- recovery anti-enumeration / abuse controls（Phase 11A）
- privileged governance strong-auth policy（Phase 11A）
- account security-event visibility（Phase 11A）
- mobile critical-path usability（Phase 11B）
- cold-start plan（Phase 11B）
- pilot operational / kill-switch drill readiness（Phase 11C）

**只有 GATE B 通过之后，才允许重开 Phase 3B（真实部署）。重开必须显式进行；
重开后必须实际完成 §4 的全部 external gates 并通过验收，之后才允许进入 Phase 12。**

#### 5.8.1 Non-Payment Production Completion Target

GATE B 前的产品工程目标正式定义为：

`NON_PAYMENT_PRODUCTION_READY`

含义是：在**不包含平台在线支付**的前提下，Marketplace lifecycle、账号生命周期、
通知、隐私/治理、RBAC/Admin、风控、Feature Flags、备份/恢复、可观测性、
incident readiness 与 Pilot 关键体验全部达到受控上线要求。

它明确 **不包含**：

- online payment
- platform fee collection
- refund
- split settlement
- withdrawal
- payment reconciliation

因此：

`NON_PAYMENT_PRODUCTION_READY != PAYMENT_READY != COMMERCIAL_READY`

Phase 15–19 仍只在 GATE C PASS 后解锁，不得为了“补齐正式上线能力”提前建设。

### 5.9 Phase 12–14 — 受控分阶段上线

- **Phase 12 — Controlled Single-Campus Alpha**（硬前置：Phase 3B 已完成/关闭；
  3B 仍 DEFERRED 时本阶段不得开始）：约 10–20 名真实用户；
  使用线下/面对面支付语义；目标是发现严重的产品与运营失败。
- **Phase 13 — Closed Campus Beta**：约 50–100 名用户；
  度量 activation、retention、listing liquidity、conversations、orders、
  completion rate、no-show、disputes、reports、moderation workload。
- **Phase 14 — Controlled Single-Campus Pilot**：约 100–300+ 名用户；
  必要时继续线下支付；验证 real demand、marketplace liquidity、repeat usage、
  transaction completion、supply/demand balance、operational workload、
  trust/safety、以及用户对在线支付的真实需求。

### 5.10 GATE C — Product Validation

**Phase 14 完成不自动开始支付。** GATE C 决定这个市场是否值得商业化，
至少评估：

- verified users、active users、active listings
- real conversations、real orders、successful transactions、completion rate
- retention、zero-result search rate、supply/demand density
- dispute rate、report rate、payment demand

**GATE C FAIL：回到产品/市场迭代，不得自动开始建设支付。
只有 GATE C PASS 才解锁 Phase 15–19 支付阶段。**

### 5.11 Phase 15–19 — Payment（仅在 GATE C PASS 后启动）

- **Phase 15 — Payment Domain Model**：仅领域模型，不需要真实资金流动。
  实体：Payment、PaymentAttempt、Refund、Settlement、PlatformFee、
  ProviderTransaction、LedgerEntry、ReconciliationRun。
  永久领域规则：`Order != Payment != Fulfillment != Dispute`。
- **Phase 16 — Licensed Payment Provider Integration**：持牌支付机构架构。
  能力：create payment、query payment、refund、query refund、provider webhook、
  signature validation、idempotency、replay protection、
  duplicate callback handling、out-of-order callback handling。
  **不得信任客户端"支付成功"状态。**
- **Phase 17 — Refund / Split / Platform Fee / Immutable Ledger**：
  refunds、split、platform fee、versioned FeeRule、fee snapshots、immutable ledger。
  金额表示：`amountMinor` + `currency`，**绝不使用 float**。
- **Phase 18 — Settlement / Reconciliation / Payment Risk**：
  对账四方——Platform Order vs Payment Provider vs Ledger vs Settlement；
  检测 MISSING、AMOUNT_MISMATCH、STATUS_MISMATCH、DUPLICATE；
  异常进入运营队列（Phase 7 ops queues）。
- **Phase 19 — Payment Operations Console**：**扩展现有 Phase 7 运营后台**，
  增加 payment transactions、payment attempts、refunds、split status、
  platform fees、settlements、ledger、reconciliation、payment exceptions、
  financial operations audit。**不得另建割裂的第二套 admin 系统。**

### 5.12 GATE D — Commercial Ready

至少要求：appropriate production infrastructure、payment reliability、
refunds、ledger、reconciliation、operational readiness、compliance、
incident readiness。

### 5.13 Phase 20–24 — Growth / Multi-Campus

- Phase 20 — Monetization Experiments
- Phase 21 — Campus Launch Playbook
- Phase 22 — Multi-Campus Architecture Validation
- Phase 23 — Second-Campus Pilot
- Phase 24 — Scaled Multi-Campus Operations

### 5.14 运营后台与支付的解耦（不变量）

**Phase 7 运营后台不依赖真实在线支付，且必须发生在在线支付之前。**
支付无关运营能力（用户管理、校园认证审核、四类商品治理、举报、moderation cases、
enforcement、appeals、disputes、support tickets、ops queues、SLA、审计可见性、
campus 配置、系统概览）不必等待任何支付阶段。

支付相关后台能力（Phase 19）依赖 GATE C PASS 后的 Phase 15–18，
并以**扩展 Phase 7 同一套运营后台**的方式实现。
主 Phase 编号不因实现顺序微调而改变。

---

## 6. Payment Architecture Guardrails（支付架构护栏）

以下为长期安全边界，任何 Phase 的实现不得越过。

**禁止架构**（不得把普通商家收款码设计成 marketplace settlement）：

```
buyer full payment
  → platform ordinary merchant QR（平台普通商家个人/商户收款码）
  → platform keeps commission（平台截留佣金）
  → platform manually transfers seller amount（平台人工转卖家应得金额）
```

Ordinary merchant collection QR is **NOT** marketplace settlement infrastructure。

**首选架构**：licensed payment institution（持牌支付机构）负责：

- payment（收款）
- split（分账）
- settlement（结算）
- refund（退款）

**Campus Marketplace（平台自身）职责**限定为：

- order domain（订单域）
- fee rules（费率规则）
- internal business ledger（内部业务账本）
- reconciliation（对账）
- audit（审计）
- operations（运营）

**必须避免**：

- custodial wallet（平台托管钱包）
- platform fund pool（平台资金池）
- undocumented seller settlement（无凭证的卖家结算）
- manual balance custody（人工余额托管）

**Phase 边界**：Phase 15 只建立 payment domain model（不需要真实资金流动），
**不等于真实支付上线**；Phase 16 才进入 licensed provider 实际接入；
且整个支付序列（15–19）只在 **GATE C PASS** 后启动。

---

## 7. Phase / Gate State Machine（阶段状态机）

统一状态枚举（并非每个 Phase 都会经历全部状态，但含义全局唯一定义）：

| 状态 | 含义 |
| --- | --- |
| `NOT_STARTED` | 未开始 |
| `IN_PROGRESS` | 实现进行中 |
| `IMPLEMENTED_PENDING_REVIEW` | executor 已实现并推送，等待独立验收 |
| `REPAIR_REQUIRED` | 独立验收发现问题，等待修复 |
| `REPO_SIDE_ACCEPTED` | 独立验收通过（仓库侧验收） |
| `MERGED_MASTER_PENDING_CI` | 已合并进 master，等待 post-merge master CI 结果 |
| `DONE_MASTER_GREEN` | post-merge master CI 全绿，阶段完成 |
| `DEFERRED` | 明确推迟（记录原因与重开条件），不视为完成 |
| `BLOCKED` | 被外部或依赖阻塞 |
| `NOT_REACHED` | Gate 尚未到达（前置 Phase 未完成） |
| `CLOSED` | 阶段全部收口（含后续验收反馈修复轮），不再有遗留工作 |

**必须记住的不等式**：

- `IMPLEMENTED != ACCEPTED`（实现不等于验收）
- `ACCEPTED != MERGED`（验收不等于合并）
- `MERGED != MASTER_GREEN`（合并不等于 master CI 全绿）
- `MASTER_GREEN != PRODUCTION_LAUNCHED`（master 全绿不等于生产已上线）
- `DEFERRED != DONE`（推迟不等于完成）
- `REPO_SIDE_ACCEPTED != EXTERNAL_DEPLOYMENT_COMPLETED`（仓库侧验收不等于外部部署完成）

executor report 不是验收依据；状态跃迁的唯一依据是 §8 Review / Merge Contract
的独立验收流程产生的客观证据。

---

## 8. Review / Merge Contract（评审与合并契约）

每个 Phase 的标准流程：

1. executor implementation（在 feature 分支实现）
2. commit
3. push
4. Draft PR
5. exact HEAD CI（PR CI 必须跑在该 HEAD SHA 上）
6. independent review（独立验收：对照仓库/PR/代码/测试/CI，而非对照 executor 报告）
7. PASS or REPAIR（验收结论只有两种；REPAIR 则回到实现方修复后重新验收）
8. explicit merge authorization（显式合并授权）
9. merge
10. post-merge master CI
11. master-green closure（master 全绿后才允许宣布 DONE / CLOSED）

**executor report 不是验收依据。** 独立验收必须实际核对：

- repository（代码在正确仓库、正确分支）
- PR（存在、Draft→Ready、diff 范围与声明一致）
- exact SHA（CI 运行在声明的 HEAD SHA 上，`CI_HEAD_SHA == NEW_HEAD`）
- code（实际读代码，不看自述）
- migrations where relevant（schema 变更逐条审查）
- tests（测试真实存在且真实断言）
- CI（required checks 全绿，无 skip）
- post-merge master（合并后 master CI 全绿）

不得因为 executor 自称 PASS 就直接 merge。

---

## 9. Production Launch Gate（生产上线门禁）

当前状态：

- `PRODUCTION_LAUNCH_BLOCKED = TRUE`

解除 launch block **至少**需要同时满足：

- **GATE B 通过后重开的 Phase 3B real deployment**（真实外部部署 + 全部 external gates 留证）
- Phase 5 governance / compliance baseline（协议、隐私、平台规则、数据治理基线）
- payment phases（Phase 15–19）——**仅当对应上线版本包含平台在线支付时**才是前置；
  Phase 12–14 的受控上线明确使用线下支付语义，不以支付 Phase 为前置，
  且上线形态在 GATE C PASS 前不得包含任何平台在线支付能力
- production smoke（公网 + 登录态冒烟）
- backup / restore（真实备份与恢复演练留证）
- security（生产安全基线复核）
- observability（监控/告警/日志在生产环境真实生效）
- incident readiness（事件响应 runbook 在生产环境可执行）

**特别注明**："网站可以启动"不等于"平台可以公开生产运营"。
`/api/health` 返回 200 只证明进程存活，不证明合规、资金安全、数据可恢复、
可观测、可回滚。在 `PRODUCTION_LAUNCH_BLOCKED = TRUE` 期间，任何文档、
报告、宣传材料不得表述为"已上线 / 已可公开运营 / production ready"。

---

## 10. MVP / Product Boundary（产品边界）

当前核心产品（MVP 范围，冻结）：

- second-hand goods（二手商品）
- errands（校园跑腿）
- skills / services（技能服务）
- rentals（闲置租赁）
- unified orders（统一订单）
- messaging（站内消息）
- reviews（评价）
- reports（举报）
- campus verification（校园认证）
- admin governance（管理后台治理）

产品核心价值：

- same-school trust（同校信任）
- short communication chain（短沟通链路）
- face-to-face delivery（面对面交付）
- campus verification / report / permission trust（校园认证 + 举报 + 权限信任体系）

**明确禁止或高风险业务**（任何 Phase、任何 Backlog 项都不得引入）：

- ghostwriting（代写作业/论文）
- cheating（代考/作弊）
- illegal finance（违规金融）
- prohibited goods（违禁品）
- prohibited account trading（违规账号买卖）
- fund-pool settlement（资金池式结算，见 §6）

---

## 11. Backlog Policy（Backlog 政策）

Master Roadmap v1.0 冻结后，这是新增想法的默认去处。

以后出现以下问题，答案**默认是进入 BACKLOG**，而不是立即插入现有 Phase：

- "还有没有什么可以优化？"
- "这个也要不要加？"
- "能不能顺手做？"

新想法**不会自动生成新 Phase**。

**只有满足以下条件之一，才能进入主 roadmap（作为当前 Phase 范围或显式 amendment）：**

- A. current-phase blocker（不做则当前 Phase 无法关闭）
- B. security / data-integrity blocker（不做则存在安全或数据完整性风险）
- C. compliance blocker（不做则存在合规风险）
- D. production-launch blocker（不做则 §9 门禁无法解除）
- E. explicit ROADMAP_AMENDMENT（走 §12 流程，作为产品决策升级）

**Backlog 项最小字段**（不满足字段要求的不算有效 backlog 项）：

- title（标题）
- motivation（动机）
- priority（优先级）
- dependency（依赖）
- candidate phase（候选 Phase：Phase 5–24 / P2 / Later）
- blocker / non-blocker（是否属于上述 A–D 类阻塞项）

禁止无限扩 Phase：现有 Phase 的冻结范围不因 Backlog 堆积而膨胀；
膨胀需求一律走 §12 amendment 决策。

---

## 12. Roadmap Change Policy（路线变更政策）

Master Roadmap v1.1（经 ADR 0002 amendment）一旦被接受即视为当前冻结版本。
修改 Phase 顺序或重大范围必须显式执行 **ROADMAP_AMENDMENT**：

1. 新增一份 ADR（`docs/adr/`，沿用现有编号递增）
2. 至少说明：
   - reason（变更原因）
   - affected phases（受影响 Phase 及其状态迁移）
   - dependency change（依赖关系变化）
   - schema / migration impact（对已有 schema/数据/部署的影响）
   - launch impact（对 §9 上线门禁的影响）
   - why backlog is insufficient（为什么 Backlog 不足以承载，必须动主路线）
3. 同步更新本文件相关章节，并保持 `MASTER_ROADMAP_VERSION` 递增

**不能因为一次聊天临时改主路线。** 会话中达成的任何新想法，先落 Backlog；
是否升级为主路线，由 amendment 流程决定。

---

## 13. Current Known Non-Blocking Debt（已知非阻塞债务）

以下为当前已知的 non-blocking 债务，**只记录事实，不升级为 blocker**
（除非未来有证据表明其构成 §11 的 A–D 类阻塞）：

| # | 债务 | 事实描述 |
| --- | --- | --- |
| 1 | npm audit：Prisma 依赖链 high findings | 来自 Prisma 依赖链的传递依赖告警，无直接修复面；跟进上游版本 |
| 2 | 历史 lint warnings | 存量警告不影响 CI 门槛；不做无必要 churn |
| 3 | private asset whole-object buffering | 私有资产签名访问当前整对象缓冲后转发，大文件内存占用待优化 |
| 4 | browser → Next → S3 proxy upload | 上传经应用中转而非直传（presigned PUT），带宽/延迟有优化空间 |
| 5 | historical /uploads/ | 历史本地磁盘上传路径残留引用清理（生产已切对象存储） |
| 6 | desktop/mobile duplicate DOM | 桌面/移动双渲染带来的重复 DOM 与维护成本（移动优先收敛建案见 Phase 11） |
| 7 | multi-instance in-process metrics aggregation assumption | `/api/internal/metrics` 为单进程指标，多实例部署时需外部聚合，当前单实例语义 |
| 8 | Redis degraded local fallback precision | Redis 故障回退进程内限流计数时，多实例精度下降（已知取舍） |
| 9 | external real alert delivery absent | 真实告警渠道未接入——因为 3B DEFERRED（无生产服务器/域名）；规则契约已就绪（docs/ALERTING.md） |
| 10 | ops shell regression local load flake | tests/ops/ops-scripts.test.ts 本地高负载偶发 120s timeout；isolated run PASS；exact-head/post-merge CI PASS（NON_BLOCKING / TEST_INFRA_DEBT） |
| 11 | ensureCampusMemberships bootstrap concurrency race | 曾存在 findMany snapshot→create 与并行 fixture mutation 竞态（P2002 / P2003 两个方向），在 PR #13 post-merge CI 34124977074（attempt=1，未 rerun）真实显形；PR #14 修复 P2002/P2003 convergence 并新增确定性真实 PG 回归；merge `97f53cd3494b24854a56b19e0418d50a5b5efeb6`；post-merge CI 34132745423 attempt=1 verify/e2e success → **CLOSED / RESOLVED_BY_CLOSURE_RECOVERY**（历史记录保留） |

新增债务一律先记录到 Backlog（§11 字段），由对应 Phase 或 amendment 决定何时处理；
**不得**在本文件之外私自把某项债务改标为 blocker。

---

## 附：文档索引

- 阶段任务明细与测试基线：[TODO.md](TODO.md)
- 非阻塞债务/Backlog 登记：[BACKLOG.md](BACKLOG.md)
- 部署与拓扑：[PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md)
- 备份/恢复：[BACKUP_RESTORE.md](BACKUP_RESTORE.md)；回滚：[ROLLBACK.md](ROLLBACK.md)
- 生产安全：[PRODUCTION_SECURITY.md](PRODUCTION_SECURITY.md)；安全设计：[SECURITY.md](SECURITY.md)
- 可观测性契约：[OBSERVABILITY.md](OBSERVABILITY.md)；告警规则：[ALERTING.md](ALERTING.md)
- 事件响应：[INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md)；日志隐私：[LOG_PRIVACY.md](LOG_PRIVACY.md)
- 产品需求：[PRD.md](PRD.md)；架构：[ARCHITECTURE.md](ARCHITECTURE.md)
