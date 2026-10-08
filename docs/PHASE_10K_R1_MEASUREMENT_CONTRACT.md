# Phase 10K-R1 — Analytics Measurement and Attribution Contract v1

**状态：CONTRACT_DEFINED / NOT_INSTRUMENTED。**
**本 PR 只定义语义、失败状态和验收要求，不增加埋点、后台统计数据、业务状态变更或上线开关。**
基础：\`master@35ac8b339f3d3510ee46319bce6bc99c17cba335\`，Phase 10K GAP-10K-01～05。
相关代码：\`src/lib/domain-events/{domain-event,domain-event-registry}.ts\`、
\`src/lib/analytics/{metric-registry,analytics-overview-query,projection-contract}.ts\`、
\`src/repositories/search-repository.ts\`、
\`prisma/schema.prisma\` 的 Conversation、Message、Order、RentalOrder、DomainEvent。

## 0. 不变量与数据分级

1. **SEARCH_TELEMETRY ≠ DOMAIN_EVENT ≠ AUDIT ≠ PAYMENT**：搜索请求不是可永存的交易领域事实。禁止将搜索词、IP、设备指纹、未哈希的访客标识、用户 ID 或搜索结果中的敏感文本写入 append-only DomainEvent。
2. **Campus 必须来自可信业务实体快照**：全站搜索本身跨校区，不得把用户注册所在校区强加给命中的所有搜索内容。v1 搜索零结果率仅提供 \`GLOBAL_ONLY\` 聚合；未来 campus-scoped 搜索先增加服务端真 scope。
3. **来源与计数单位不可混用**：domain fact 是带严格 payload/occurrenceKey 的 canonical state transition；搜索是每次服务端完成的 request attempt。未定义的分母、不同版本 cohort、不足观察期，必须返回 \`UNAVAILABLE\`，绝不展示 0% / 100%。
4. **只统计可比 cohort**：同时锁定 \`metricDefinitionVersion\`、UTC 窗口、tenant、业务类型、合法参与方、事件发生时间。运营展示北京时间，存储分桶使用 UTC；v1 固定 7 天成熟归因窗口和 7×24h / 30×24h 报告窗口。为避免迟到事件漏数，**只有关闭观察期并证明投影/回填覆盖完整的 cohort 才可出率**。
5. **不复用审计/支付权限**：读面默认 \`analytics.read\`，CAMPUS 只有 ACTIVE membership 授权校区，SQL 强制 campusId；无证据或 projection 不健康时降级为不可用。不要给用户增加已认证的“转化成功”权限。
6. **数据生命周期**：搜索原始 request ID 仅在短生命周期去重范围可见，常态永久库只保存 \`(UTC time bucket, global scope, eligible, zero-result, count)\` 低基数字段。采集前必须完成隐私治理（目的、告知、数据保留上限、反滥用/爬虫过滤、非必要采集关闭）；故障时主搜索成功不受统计失败阻断，但该窗口完整度 = UNKNOWN。
7. **无负值与无静默补偿**：无法区分用户/机器人、撤销/取消、跨校区归属或 repeat occurrence → \`UNAVAILABLE\` 或排除并记录覆盖范围，不得将旧 metric contributions 强行凑新转化指标。

## 1. 指标合同（版本均提议为 1；R2/R3 实现前不登记至生产 MetricRegistry）

| 指标 | 权威来源及 scope | 分子 / 统计值 | 分母 / 条件 | 可用性 |
| --- | --- | --- | --- | --- |
| SEARCH_ZERO_RESULT_RATE | 完成后的服务端全站搜索结果；GLOBAL_ONLY | 有效关键词且公开四类结果均为 0 的请求数 | 同时间窗可判定成功、过滤机器人、非空关键词的有效搜索请求数；每次真实请求算一次 | 无采集 → 不可用 |
| LISTING_TO_CONVERSATION_RATE | Canonical LISTING_CREATED + Conversation 直接 listing FK；EXACT_CAMPUS | 已发布 listing cohort 中，7 天内出现≥1 个满足非自聊、不同用户、关联该 listing 的有效新会话的 listing ID 数 | 同校区同类型于 cohort 开始时新创建且公开可见的唯一 listing ID 数。分子最多计一次；不是 impression→conversation 点击率 | 归因和完整性未核证 → 不可用 |
| CONVERSATION_TO_ORDER_RATE | Conversation/FK + canonical Order/RentalOrder；EXACT_CAMPUS | 合格 conversation cohort 中 7 天内产生首个具有**可信对话归因**订单的 conversation 数 | 已建立且发生过有效用户互动的 listing-scoped conversation 数；订单先于对话或无法证明关联则不得追溯计入 | FK 不足以证明归因 → 不可用 |
| TIME_TO_FIRST_INTERACTION | Conversation.createdAt + 第一条合格 Message；EXACT_CAMPUS | 创建至第一条另一位真实参与者首次非系统回复的秒数（非聚合可见的明文消息） | 只为确实存在该响应的完整 cohort 计算分布/中位数；同时报告覆盖率与样本数。未回复为 censored，不得记作 0 秒 | 消息类型及参与身份尚未统一 → 不可用 |
| SUPPLY_DEMAND_GAP | 同校区同类别同时间点的可曝光供给 capacity 与仍开放的 unmet demand；EXACT_CAMPUS | \`max(0, eligible unmet demand units - compatible available capacity)\` | 对同一业务类型、单位与服务/商品/租赁类型归一化后的分类进行比较；无法兼容分类时禁用 | 当前跨商品/服务/租赁单位不兼容 → 不可用 |
| PILOT_NORTH_STAR | 产品指标正式冻结之后的 canonical completed transactions；EXACT_CAMPUS | **候选**：每校区每个完整 UTC 周，合法完成并去重的交易数 | 需先审批唯一交易语义、取消/冲正规则、观察窗口、试点成功阈值；非收入/GMV | 产品定义未批准 → 不可用 |

### 指标独立性 / 禁止的近似

- \`Product.viewCount\`、\`RentalListing.viewCount\` 当前不证明独立曝光、相同校区或参与者唯一性；不得拿它作 listing 漏斗分母。
- \`Conversation.orderId\` / \`rentalOrderId\` 可能来自下单自动建会话；有 FK ≠ 订单由先前会话转化。必须验证时间序 + canonical 链接，不能把 order-first 会话计作成功。
- 10J “期间新增供给”、“期间创建需求”、“当前在售供给”各有不同母集，不能除出发布后聊天转化率、供需缺口或留存。
- \`COMPLETED_TRANSACTION_VALUE\` 是 CTV（目前不含 Service 定价），不得作为北极星的金额或支付/结算口径。
- 供需缺口若缺少业务状态与可匹配类别映射，宁可整项不可用，不可将新增需求事件数直接减当前在售数量。
- 搜索无结果的“有效请求”包含服务器成功计算且没有任何合法可见结果，不包括空关键词、出错请求、健康检查、自动探测、分页或非法请求。不得把搜索详情页的“没有结果”展示自动当作已持久化统计。

## 2. R2/R3 的 authoritative seams（契约约束，不是实施完成宣告）

**R2a 全站搜索**：保留既有 \`getSearchResults\` 公共结果契约；在服务端计算四类结果并确认成功之后产生最小统计事实，设计按时间桶的聚合权威和去重/失败标记。非采集配置场景只保持正常搜索，显示的 analytics completeness = UNKNOWN，绝不声称搜索零结果率为 0。

**R2b listing→conversation**：在已有 canonical Conversation 创建路径里验证关联 listing FK、参与者身份、创建先后、创建时曝光与校区，在同一业务事务内产生**唯一**可追溯的归因事实。不要相信浏览器传来的 campusId / claimed orderId，也不要在用户编辑 listing 时生成新 publish event。历史缺乏可证据的 conversation 不补算为新事实。

**R2c conversation→order / first interaction**：必须从创建订单和发送 Message 的 canonical transaction 读取参与者和 parent listing，而不是单凭 \`Order.createdAt\` 或系统消息；order-first conversation 跳过并记录 excluded reason。只把符合 provenance 的原子事实归因到原始会话。允许新事实的事件定义独立增加版本，不改变历史 \`ANALYTICS_METRIC_PROJECTION_VERSION=3\` 的语义；如需扩展旧 projection，显式 bump version 并做完整 backfill。

**R3a 供需状态**：冻结匹配 category mapping、可用量/时间和需求状态；仅对可比较的业务类型输出缺口。跑腿“开放任务”属于需求但不具备对应供给 catalog，不能擅自合并进 listing 供应。
**R3b 北极星**：先经产品批准 KPI 与阈值后建立算式，再增加按校区的完整周聚合；试点前真实历史不足时返回数据不足。

### 并发 / 失败 / 隐私测试 Gate

- PostgreSQL concurrency：相同业务事实并发重试、回滚、事务后 worker crash 与 replay，确保 exactly-once contribution；同一 conversation 不得跨校区归因。
- Counterexamples：重复搜索请求与 web retry、客户端伪造 campus、交叉校园 listings、订单先于对话、群聊/系统消息、撤销与软删、迟到投影、缺失分母、所有零流量情形、时区跨日、孤儿 FK 与用户抹除。
- Privacy：抓取 DomainEvent、AdminAudit 和日志，断言无搜索词/原始 IP/visitor PII；默认无个人浏览追踪，不允许 analytics.read 查询个体搜索历史。
- Acceptance：typed contract unit + real PG + Playwright；exact-HEAD CI / independent audit / explicit merge / post-merge master CI。每个缺口关闭必须有真正 authority 证据，不能只靠合格的纯函数。

## 3. 维护与冻结

- \`measurement-contract.ts\` 中六项 \`status=UNAVAILABLE_PENDING_INSTRUMENTATION\` 为**开发时护栏**，不是现成 analytics 查询、现成 metric registry 或业务统计结果。
- R2/R3 需要分布式事件的延时水位/重建策略、经授权的低基数聚合与健康标记。等相关指标通过测试，再按独立 PR 从 pending 改为 ready，禁止一次把六项全部转正。
- 需产品确认项：北极星指标（候选是每校区每周完成交易数）及接受阈值；聊天漏斗 cohort 7 天窗口、搜索隐私告知/保存期限。如未通过审批，保持不可用。
- Phase 10K 的当前结论仍为 \`REPAIR_REQUIRED\`；Phase 10 整体保持 \`IN_PROGRESS\`；不重开 Gate B / Phase 3B。
