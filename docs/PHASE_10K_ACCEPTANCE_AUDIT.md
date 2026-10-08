# Phase 10K — Phase 10 独立验收与范围差异报告

**审计日期**：2026-10-08  
**代码权威基线**：`master@35ac8b339f3d3510ee46319bce6bc99c17cba335`  
**最终主干 CI**：[run 37777868261](https://github.com/ljjnb666-nb/Campus-Marketplace/actions/runs/37777868261)：`push / exact-master HEAD / completed / success`；verify + E2E 均 success。  
**量化证据**：487 test files、4,261 tests PASS；97/97 Playwright PASS；Lint / Typecheck / Build PASS。  
**验收结论**：**PHASE_10K_REPAIR_REQUIRED / PHASE_10_IN_PROGRESS**。CI 已绿，但冻结范围有未交付项目。该结论为**阶段范围阻塞**，不等于发现生产权限 fail-open 或 P0/P1 runtime security 漏洞。

## 1. 权威合同

`docs/MASTER_ROADMAP.md` §5.6 是 Phase 10 交付范围 SSOT，明确包含：
- business event analytics / event versioning / marketplace liquidity;
- search zero-result metrics / supply-demand gaps;
- listing → conversation conversion / conversation → order conversion;
- order completion / time to first interaction / active listings / north-star metric;
- RiskSignal / rule-based Risk Engine / Feature Flags / Campus Config；
- server-authoritative GLOBAL/CAMPUS kill switches, maintenance/read-only, edit & creation guard。

**不变量**：`CI_GREEN != PHASE_SCOPE_COMPLETE`；`REPO_SIDE_ACCEPTED != PRODUCTION_DEPLOYED`；`ANALYTICS != AUDIT != PAYMENT`。不得在合同缺口存在时改写 Phase 10 为 CLOSED。

## 2. 已验收实现（本次复核的具体入口）

| 子域 | 现有证据 / 已具备能力 | 本次结论 |
| --- | --- | --- |
| Event/Projection | `src/lib/analytics/domain-event-projection.ts` + `projection-contract.ts`：版本化 DomainEvent → Receipt → Contribution，receipt 幂等校验、版本隔离 | 已有实现与 master-green 验证 |
| Liquidity | `metric-registry.ts` 的 4 个指标（新增供给、创建需求、完成交易、已完成交易记账对价）；`liquidity-snapshot.ts` 的按校区当前可见供给 | 已有实现与 master-green 验证 |
| Analytics UI | `/governance/analytics`，独立 `analytics.read`，fresh actor 授权、校区 SQL predicate、7/30 日窗口与 Decimal 汇总；不将 CTV 表述为结算/GMV | 10J PR #80，post-merge 97 E2E |
| Risk | `risk-intelligence.ts` 可解释无分数规则、未确认举报/纠纷只作为观察上下文、与 RiskState/EnforcementAction 分离 | 已有实现与 master-green 验证 |
| Runtime Config | `runtime-config-registry.ts` 仅白名单 RISK_SIGNAL_EVIDENCE_LIMIT，含有界安全回退及版本化权限界面 | 已有实现与 master-green 验证 |
| Kill Switch | `feature-flag-registry.ts` 九个注册开关；`feature-flag-guard.ts` 持锁事务读、GLOBAL 优先、故障拒绝新活动、恢复路径 carve-out；10G 中文管理界面 | 已有实现与 master-green 验证 |

**证据边界**：上述“已实现”只表明查到对应代码和累计 CI 验证，不代表本次以外部生产流量、真实多机部署证明，亦不掩盖以下冻结合同缺口。

## 3. 阻塞项（Phase 10 不能 CLOSED）

| 编号 | 冻结范围 | 实际代码事实 | 阻塞等级 |
| --- | --- | --- | --- |
| GAP-10K-01 | Search zero-result rate | `src/app/search/page.tsx` 调用 `getSearchResults` 仅渲染结果；`src/repositories/search-repository.ts` 查询现有业务数据，未持久化去标识化搜索尝试/零结果统计。`metric-registry.ts` 仅定义 4 个流动性指标 | P1_PHASE_CLOSE_BLOCKER |
| GAP-10K-02 | Listing → conversation conversion | 当前 4 个指标无 listing view/impression 与 conversation-start 的可靠联合分母及归因；不能用“新增供给/需求数”冒充 conversion | P1_PHASE_CLOSE_BLOCKER |
| GAP-10K-03 | Conversation → order conversion + time to first interaction | 现有 Projection 指标没有会话首互动、关联订单漏斗及有效归因窗口定义；直接相除会导致错口径 | P1_PHASE_CLOSE_BLOCKER |
| GAP-10K-04 | Supply/demand gaps | 仅有「现在的供给存量」与「期间的新增需求/供给事件」；不能作为同一时间点、同一分类/校区的匹配率或缺口 | P1_PHASE_CLOSE_BLOCKER |
| GAP-10K-05 | North-star metric | `MASTER_ROADMAP` 要求但尚无冻结的 numerator/denominator、时间窗、校区归属、去重和试点成功阈值；10J 页面明确列为未建立可信口径 | P1_PHASE_CLOSE_BLOCKER |

**不算阻塞**：单纯没有图表、未来 100+ 校区选择器分页优化，不影响 Phase 10 当前合同完成的核心语义。**不能用 UI 展示零、推测曲线或部署一个没有权威事件的计数器来关闭 GAP-10K-01~05**。

## 4. 可执行修复顺序

1. **10K-R1 Measurement Contract**：为五组指标明确单位、维度、授权范围、窗口、UTC 时区、去重、降级与历史回填边界。全站搜索是跨校区搜索，必须先决定校园 attribution：不要把全球搜索的零结果错误归入某个 campus。默认不保存原始搜索词/IP/查询者标识；使用低基数聚合。
2. **10K-R2 Search + Funnel Facts**：先建立服务端可信埋点与必要的 DomainEvent/按日聚合结构，定义唯一 attribution ID、关联已有 canonical conversation/order event；绝不直接通过客户端上报的成功数作业务权威。交易一经完成后复用 immutable completion facts，不重复计数。
3. **10K-R3 Supply/Demand + North Star**：使用对齐的校区/类别/时间窗及曝光/需求的有效状态来构造匹配缺口；推荐北极星候选为「每校区每周完成的有效交易数」，但**冻结前不得当作已批准的产品指标**。所有不具备 authority 的项目显示 unavailable 而非 0。
4. **10K-R4 Independent Acceptance**：逐一真实 PostgreSQL 测试跨校区、重复/重试、退单/取消、回填、旧 projection 版本、迟到事件/窗口边界与缺失值。补真实 E2E、权限拒绝、隐私与原有 97/97 浏览器回归。每项 scoped diff → PR → exact-head verify/e2e → 独立审计 → 显式授权 merge → exact-master 双绿。
5. 修复全部缺口之后，追加真正的 Phase 10 closure record，并标记 `DONE / MASTER-GREEN / CLOSED`。在此之前，Phase 11 可做依赖分析，但 `GATE B = NOT_REACHED`，Phase 3B 不得重开。

## 5. 发布门禁、禁止事项与结论

- **Phase 10J：`CLOSED`**（PR #80 merge `35ac8b339f3d3510ee46319bce6bc99c17cba335`，post-merge CI `37777868261` 双绿）；禁止因 10K blocker 倒退已经完成的 10J。
- **Phase 10K：`REPAIR_REQUIRED`**，因为 SSOT §5.6 的 GAP-10K-01~05。
- **Phase 10 整体：`IN_PROGRESS`**。不得把 CI 双绿等同全范围完成，也不得以文档标记取代 missing telemetry 的真实实现。
- **Production launch**：`PRODUCTION_LAUNCH_BLOCKED = TRUE`（既有 Phase 3B / GATE B 约束不变）。
- 不改任何既有业务 state machine / RBAC / RiskState / AuditLog，不因 metrics 新增把个人敏感搜索行为暴露给校区管理员。
