# Phase 10I — 风险情报只读查询台

## Scope
- Route: /governance/risk. 独立于执法、审计、风控处置、配置编辑。
- 仅持有 risk.read 的操作者进入；GLOBAL 可以查询全范围或精确校区，CAMPUS 只能查询 ACTIVE membership 内已授权校区。
- 输入一个目标用户 ID，返回 Phase 10D 规则评估、命中规则、聚合数量与 10E runtime config 限制的最小证据。
- 查询前校验页面 scope；SQL 过滤必须由原 10D 授权读取模型完成。严禁 UI 端过滤后隐藏跨校区记录。
- 不查询用户资料；未知用户与无活跃信号用户保持相同外观，避免用户存在性 oracle。
- 信号仅是咨询性参考，不提供自动处罚/改 RiskState/EnforcementAction 的入口，不暴露 reasonCode/note/sourceId/actor。
- 中文状态 + 无数据态 + 参数非法态 + 证据截断提示；导航按风险窄权限独立呈现。

## Exit criteria
- 页面 RBAC 单测：risk.read-only、未授权 direct URL、伪造校区、数组/异常 query、无用户 ID 零查询。
- Playwright 真实浏览器：相同目标用户在两校区的信号严格分离，未核实举报不会直接升级 REVIEW，GLOBAL 全范围结果独立。
- exact-HEAD verify / E2E 双绿 + 独立审计；用户单独批准后方可合并。
- exact-master post-merge CI 双绿才允许标记 10I CLOSED；Phase 10 整体保持 IN_PROGRESS。
