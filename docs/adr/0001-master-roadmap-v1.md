# ADR 0001: Freeze Master Roadmap v1.0

- **Status**: Accepted
- **Date**: 2026-09-02
- **Baseline**: master @ `be0fd94c92a751c0dd6acd1f417abdd42b6f5751`
- **Canonical document**: [docs/MASTER_ROADMAP.md](../MASTER_ROADMAP.md)

## Context

Production Phase 4（Observability / Monitoring / Recovery）已于 2026-09-02
合并进 master（`be0fd94c`），post-merge master CI 全绿，并经三轮独立验收收口。

至此，仓库已先后完成 Phase 1（对象存储/敏感资产安全）、Phase 2（关键链路
E2E / Release Gate）、Phase 3A（仓库侧部署基础）、Phase 4（可观测性基础），
而 Phase 3B（真实服务器上线）因外部资源缺口保持 DEFERRED。
仓库侧工程基础至此验收完毕（GATE A — Engineering Reliability PASS）。

在缺乏单一权威路线文档的情况下，存在以下实际风险：

- 临时插入新 Phase，导致 Phase 编号漂移
- 已完成 Phase 的状态被后续文档覆盖或改写
- Phase 3B 的 DEFERRED 被误读为已完成
- 支付被过早推进（例如 Phase 14 试点一结束就自动开建支付），或把
  "普通商家收款码 + 人工转账"误当作合法的分账方案
- 运营后台与支付被错误耦合（认为运营后台必须等真实支付，
  或支付另建第二套割裂的后台）
- 新想法随意塞进当前 Phase，范围无限膨胀
- 各文档间出现互相矛盾的 Phase 状态

## Decision

1. **Phase 1–4 状态固化为**：
   Phase 1 DONE / MERGED / MASTER-GREEN；Phase 2 DONE / MERGED / MASTER-GREEN；
   Phase 3A DONE / MERGED / MASTER-GREEN；Phase 4 DONE / MERGED / MASTER-GREEN / CLOSED。
   **GATE A（Engineering Reliability）= PASS**：仓库侧工程基础验收完毕。
2. **Phase 3B 保持 DEFERRED**：真实外部生产部署未完成；
   `PHASE_3B_REAL_DEPLOYMENT = DEFERRED`、`PRODUCTION_LAUNCH_BLOCKED = TRUE`。
   3B 只能在 **GATE B（Pilot Ready）通过后重开**；Phase 5–11 乃至 12–24
   完成也不能自动把 3B 视为完成。
3. **Phase 5–24 顺序冻结（含 Gate A–D）**：
   - Phase 5 隐私/协议/平台规则/数据治理（NEXT）
   - Phase 6 身份/信任/安全/RBAC/审计（Campus 一等实体、CampusMembership、
     校园认证生命周期、AdminAuditLog 等）
   - Phase 7 运营后台基础（必须在在线支付之前完成，且不依赖真实在线支付；
     未来支付运营扩展同一后台，不建第二套 admin）
   - Phase 8 交易市场生命周期加固（listing/reservation 状态机、meetup/no-show、
     争议感知交易、评价完整性、消息安全）
   - Phase 9 异步任务/事务性 outbox/通知域/保留清理（不引入 Kafka 与不必要微服务）
   - Phase 10 分析/流动性/风险/配置中心/Feature Flags（Analytics 与 Audit 分离）
   - Phase 11 试点就绪（移动优先、onboarding、冷启动；不要求在线支付）
   - **GATE B（Pilot Ready）→ 重开 Phase 3B**
   - Phase 12 单校区 Alpha（10–20 人，线下支付）→ Phase 13 封闭 Beta（50–100 人）
     → Phase 14 单校区 Pilot（100–300+ 人）
   - **GATE C（Product Validation）**：Phase 14 完成不自动开始支付；
     FAIL 则回到产品迭代，PASS 才解锁支付
   - Phase 15 支付领域模型（仅 domain，`Order != Payment != Fulfillment != Dispute`）
     → Phase 16 持牌支付机构接入 → Phase 17 退款/分账/平台费/不可变账本
     （amountMinor + currency，绝不 float）→ Phase 18 结算/对账/支付风险
     → Phase 19 支付运营台（扩展 Phase 7 同一后台）
   - **GATE D（Commercial Ready）**
   - Phase 20–24 增长与多校区（变现实验、开城 Playbook、多校区架构验证、
     第二校区试点、规模化多校区运营）
4. **Backlog-first policy**：新想法默认进 Backlog，不自动生成新 Phase；
   进入主路线仅限 current-phase blocker / security / data-integrity /
   compliance / production-launch blocker 或 explicit ROADMAP_AMENDMENT。
5. **Roadmap amendment requirement**：修改 Phase 顺序/重大范围必须新增 ADR
   （说明原因、受影响 Phase、依赖变化、schema/migration 影响、上线影响、
   为何 Backlog 不足），不能因一次会话临时改主路线。
6. **Payment / provider guardrail**：禁止"买家全额付款 → 平台普通商家收款码 →
   平台截留佣金 → 人工转卖家金额"的架构——普通商家收款码不是 marketplace
   settlement 基础设施。支付/分账/结算/退款必须由持牌支付机构承担；
   平台仅负责订单域、费率规则、内部业务账本、对账、审计与运营；
   避免 custodial wallet / platform fund pool / 无凭证卖家结算 / 人工余额托管。
7. **运营后台不依赖支付**：Phase 7 运营后台基础（用户管理、认证审核、
   四类商品治理、举报、moderation cases、disputes、support tickets、ops queues、
   审计可见性、campus 配置、系统概览）不依赖真实在线支付，且排在支付之前；
   支付运营（Phase 19）在 GATE C PASS 后以扩展现有后台的方式实现。

## Consequences

- `docs/MASTER_ROADMAP.md` 成为 Phase 顺序 / Phase 状态 / Gate / launch blocker /
  backlog policy 的唯一权威来源；其它文档与其冲突时以其为准。
- 任何文档、报告不得声称 `PRODUCTION_READY = TRUE`，直至 §9（Production Launch Gate）
  全部门禁解除、GATE B 通过后 3B 实际完成。
- 支付推进被 GATE C 显式闸住：Phase 14 完成不自动开始 Phase 15；
  GATE C FAIL 时回到产品/市场迭代。
- 后续新增需求默认记录为 Backlog 项（含 title / motivation / priority /
  dependency / candidate phase / blocker 标记），不再直接扩 Phase。
- 已知非阻塞债务（npm audit Prisma 依赖链、私有资产整对象缓冲、proxy 上传、
  双渲染重复 DOM、单进程 metrics 假设、Redis 降级精度、真实告警渠道缺失等）
  保持 non-blocking 记录，不随本轮升级。
- 后续所有 Phase 的评审/合并沿用统一 Review / Merge Contract：
  Draft PR → exact HEAD CI → 独立验收（PASS/REPAIR）→ 显式合并授权 →
  merge → post-merge master CI → master-green closure；
  executor report 不作为验收依据。
