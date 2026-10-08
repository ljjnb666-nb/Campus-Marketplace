# Phase 10J — 运营分析与校园流动性只读控制台

## Scope
- /governance/analytics 中文只读面；仅 analytics.read，GLOBAL 可按单一校区选择，CAMPUS 只能选择其 ACTIVE membership 的已授权校区，不提供未经定义的跨校区合计。
- 数据：Phase 10C 当前状态可见供给（PRODUCT/SERVICE/RENTAL）及 Phase 10B/10C 当前 ProjectionVersion 的 7/30 日窗口新增供给、创建需求、完成交易、已完成交易记账对价。
- 每种 metric 还需精确 MetricVersion，含维度拆分与 Decimal 精度；仅 SQL 精确匹配 campusId，禁止 JS 多租户过滤。
- 事件窗口按 UTC 绝对时间 occurredAt 计算，显示北京时间；快照指标不同于期间事件，不能混合分母计算伪转化率。
- 延迟/回填/未来 projection 升级不保证 complete。CTV 不等于 GMV、在线收款、平台收入或结算；SERVICE 无合同金额，刻意不贡献 CTV。
- 搜索零结果率、漏斗转化、留存、首次互动、供需缺口：尚无可证实完整权威数据，必须呈「待建立可信口径」，不得捏造零值。
- analytics.read 与 operations.overview/audit.read/risk.read 均独立；data-only transactional migration 只向 PLATFORM_ADMIN 默认授予该新能力，绝不扩大 legacy full-admin 等价集合。
- 新增页面、服务和测试，不改写业务 DomainEvent writer / projection 版本 / canonical order state。

## Exit Criteria
- RBAC、CAMPUS membership、伪造 scope、非法 GET 查询的零聚合；操作员读服务 fresh re-auth。
- 严格按 projectionKey/version + metricKey/version + campusId + occurredAt 过滤，Decimal 口径真实 PG 验证，当前在售数必须剔除隐藏/软删记录。
- Playwright 真实页面：GLOBAL admin 查询两个互斥校区与 7/30 天事件，不能看到另一校区。
- exact-HEAD CI verify/e2e 双绿 + 独立审计；未经用户批准禁止 merge；合并后 exact-master CI 双绿才关 10J。
