# Phase 10H — Runtime Config 中文治理控制台

## Scope
- URL: `/governance/runtime-config`，独立于 legacy `/admin`。
- 仅展示 `RUNTIME_CONFIG_REGISTRY` 已登记的非敏感参数（当前 `RISK_SIGNAL_EVIDENCE_LIMIT`，范围 5–50，默认 50，故障安全回退 10）。
- GLOBAL / CAMPUS 授权 scope，当前值、来源、校区覆盖值、版本、最近 20 条修订记录。
- 显式数值或版本化 NULL/INHERIT tombstone；二次确认、中文反馈、刷新冲突。

## Authority and invariants
- `runtime.config.manage` 与 `feature.flags.manage`、`risk.read` 独立。
- 导航不是授权；叶页面先校验 scope，再查询校园元数据；10E operator query 再复核 RBAC。
- 写入仅通过 `setRuntimeConfig`：服务端 session actor → USER governance lock → fresh RBAC → typed bounds → version CAS → immutable revision → AdminLog，单事务失败全回滚。
- 未授权校区、缺失校区、未知 key、重复 form field、伪造 actor、无确认或不合规整数均不允许写入。
- UI 不能改变风控规则、RiskState、EnforcementAction 或访问权限。
- 读失败只可按 10E 既有安全回退显示；禁止将 SAFE_FALLBACK 伪装为正常配置。
- E2E 遵循受 `assertE2EDatabaseIsolation` 严格保护的重置；RuntimeConfigRevision/Override 两表定向 TRUNCATE 无 CASCADE；生产 immutable 规则不变。

## Exit criteria
- Typecheck / lint / Vitest coverage / build 全绿。
- 用户从真实浏览器修改校区参数、二次确认、恢复继承；以 PostgreSQL 验证 CAS version、两次 revision、两次 AdminLog。
- 精确 PR HEAD CI verify + E2E 双绿，再独立 review；**禁止自动 merge**。
- 合并后 exact-master CI 双绿，才允许标记 `PHASE_10H_RUNTIME_CONFIG_UI_CLOSED`。
- 10H 不代表 Phase 10 整体关闭；Risk / Analytics 管理界面与综合 Gate 仍未收口。
