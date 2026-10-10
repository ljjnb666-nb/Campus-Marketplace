# Phase 10K-R2d-03B-02B-02B-11 — 独立观测者权威与持久化证据架构决策

**状态：PROPOSED / DESIGN GATE ONLY / EXTERNAL TRUST ROOT NOT PROVISIONED / PRODUCTION NOT AUTHORIZED。**

## 1. 为什么停止追加候选一致性检查

现有 candidate Ed25519 校验、调用方提交的 SPKI pinset、receipt hash 链、checkpoint proposal、fork/timeline/window/overlap 及授权漏斗读取防火墙，已能拒绝许多局部矛盾；这些结果仍然全是**调用方提供的候选数据**。

当前真实代码边界：

- `funnel-host-observer-signature.ts` / `funnel-host-observer-key-pinset.ts` 接收调用方控制的 key registry / pin 候选，签名通过不代表主机身份。
- `funnel-host-observer-candidate-checkpoint.ts` 返回内存提案，`funnel-host-observer-candidate-fork.ts` 只检查**同次提交集合**；分别提交的分叉可以各自通过。
- `HostLifecycleClaim` / `FunnelCaptureClaim` 在 PostgreSQL 中以 `UNVERIFIED` 保存；DB 约束与 append-only trigger 是普通 DML 防线，不是独立来源或外部防篡改锚。
- `compose.production.yml` 当前应用与后台 worker 使用应用环境配置，没有一个独立身份、独立密钥保管及完整主机清单的运行方。
- `loadAuthorizedFunnelDiagnostic` 仍必须拒绝在缺失可信采集连续性时发布转化率。

**决策：** 此切片只冻结可实现的权威分层、数据所有权、事务不变量、外部前置条件及验证门禁；不再添加第六种候选纯函数，也不把产品代码改成读入“已验证”布尔值。

## 2. 威胁模型与权威分层

| 层 | 所有者 / 数据来源 | 能证明 | 不能证明 |
| --- | --- | --- | --- |
| L0 候选数据 | 应用、worker、任意提交者 | 输入在一次有限检查中没有检测到矛盾 | 主机真实性、遗漏历史 |
| L1 独立注册根 | 与应用部署/数据库管理分离的运营签发方 | 某个公钥由运营方批准给规定的 principal/host/epoch | 该主机当前在运行，事实从未丢失 |
| L2 独立主机观察 | 受限定权限的外部宿主机/编排观察者 | 被签发主体在具体时间提交了机器观察 | 任意未知主机不存在、业务事件完整 |
| L3 持久化接收权威 | 独立接收器 + 原子日志/检查点 + 外部锚 | 已接收证据的顺序、竞争分叉、重试及缺口 | 未观测到的事件不存在 |
| L4 部署成员/源数据核对 | 独立编排清单 + 业务源台账/配置历史 | 指定时间窗的成员与发射资格、来源一致性 | 没有额外外部遗漏，除非有演练证据 |
| L5 生产 KPI 发布 | 另行审核的发布决策 | 符合明确范围的指标可公开 | 不得由任一候选结果直接授予 |

尤其要分开 **已批准公钥**、**运行中宿主机归属**、**完整集群清单**、**采集连续性**、**发布权**。单个 manifest、签名或 Docker event 均不能跨越多层。

对手包括恶意候选提供者、拥有应用凭据的攻击者、重复/乱序并发请求、机器或进程崩溃、过期/撤销密钥、错误的部署成员清单、主机失联、部分滚动发布，以及有权限修改同一 PostgreSQL 的内部人员。**同宿主机同权限观察者不构成对该宿主机受侵时的独立取证保证**；需要隔离运营面与异地主体来界定剩余风险。

## 3. 首选方案：独立签发与最小权限观察平面

### 3.1 明确分离的所有权

1. **签发方：** 由应用、worker、Web 管理员、普通 DB 写入角色之外的运维主体持有注册根私钥；根私钥不放在 Git、GitHub Actions、应用数据库、.env.production、普通 Docker volume 或日志中。根指纹首次安装必须有独立可信交付和双人复核记录，不能由客户端请求决定。
2. **注册记录：** 采用经签名的不可变版本化授权清单；记录 `principalId`、`hostId`、`keyId`、规范 Ed25519 SPKI 指纹、有效起止 UTC、注册版本、吊销状态、明确的 workload/编排 scope，以及可审计的批准决策 ID。拒绝任意用户信息、密钥私有部分和自由文本扩展。
3. **观察主体：** 真实宿主机或编排层的**独立受限进程/账户**。不得与 app/async-worker 共用数据库写入凭据、NextAuth/指标 bearer secret 或客户端自报密钥。获取 Docker/编排事件优先通过受限代理/只读授权接口；不可为了便利把裸 Docker socket 挂入公开 Web/worker。
4. **验证/接收主体：** 只能读取由运维平面交付并经预置根验证的注册快照，不能接受请求中的替代 key registry；仅允许活跃、未吊销、scope 对应、版本未回滚的主体入账。其数据库角色与 app writer 分离，且无 KPI 发布权限。
5. **独立锚：** 应用数据库不是对其高权限管理员的独立取证源。审计链的批次 digest/序号需要周期性写入受独立运维方控制、禁止应用改写的异地追加型保存位置；未锚定的区间明确为未认证历史。

### 3.2 注册状态机和密钥周期

`UNENROLLED → PENDING_APPROVAL → ACTIVE → SUSPENDED / REVOKED / EXPIRED`。激活必须由签发方批准且与外部 host/workload inventory 核对，不能由签名成功自动激活；吊销后任何旧 key 的新入账失败关闭。轮换使用**新的 keyId + 新的公钥 + 新的 epoch**；允许经批准的有限重叠，但不得允许旧版本回滚或把历史间隙补记成完整。根轮换单独双重授权并保留签发链记录。

注意：离线签名登记证明“运营方批准了公钥”，不等于硬件不可克隆身份。无 TPM/远程证明和主机入管事实时，只能声明经过运维核对的**主体绑定**，不得使用“已验证物理宿主机不可冒充”的措辞。

### 3.3 显式外部前置条件（当前均未视作已完成）

- 实际宿主机/编排平台、运行主体清单及谁拥有完整部署 inventory。
- 独立的密钥保管与签发通道、注册根 bootstrap/pin 分发和吊销通道。
- 受限事件采集接口、可信接收器的运行地点及与应用凭据的权限分割。
- 独立持久化/外部锚、备份和恢复方案，以及可操作的故障演练环境。
- 由运营方确认的保留期限、隐私/安全审查与预算。

**任何一个缺失都不得通过代码默认值或测试 fixture 伪装为已满足。** 这份 ADR 不是外部资源已就绪的证明。

## 4. 后续持久化检查点的事务设计（本 PR 不实现）

计划独立存储两个概念：

- 仅已准入 receipt 的不可变 journal：`authorityVersion, principalId, hostId, sessionId, sequence, previousHash, receiptHash, signedAt, observedAt, receivedAt, verifiedRegistryDigest`。拒绝或冲突的输入只能进入独立的、严格脱敏的 quarantine/audit 记录，不得混入连续性权威日志或推进 cursor。绝不存原始 Docker payload、用户 ID、IP、认证令牌、私钥或不必要业务内容。
- 单一权威 cursor：以 `(authorityId, principalId, hostId, sessionId)` 为 key，记录上次已确认 `sequence, receiptHash`、DB 收到时间及明确状态（`CONTIGUOUS / GAP / QUARANTINED / REVOKED`）。允许新 session 仅通过经过审计的 session-start 边界，绝不把 reset 隐性接到旧窗口。

**原子提交不变量：** 签名的规范化及 Ed25519 校验在数据库事务**之外**对已钉住的注册快照完成；事务内必须锁住同一权威版本的数据库镜像/epoch fence，重新检查主体、host-scope、有效期与吊销状态，以及快照 digest 未被更新或回滚，然后锁定唯一 cursor、校验前驱 hash 与精确 `lastSequence+1`、插入不可变 receipt、CAS 更新 cursor，最后一次性提交；任何一项失败则全事务回滚。外部注册版本同步必须单调且可审计，过期/无法确认新鲜度的快照 fail closed，吊销生效/传播的最大时限须先由运营方冻结并演练（不能声称跨网络存在瞬时原子吊销）。优先明确 PostgreSQL row lock + 唯一约束 + 条件更新的线性化点；应用侧内存锁或 Redis TTL 不得替代数据库事务。

- 相同 receipt 的重复请求只能得到已入账的幂等结果；同一 slot 不同 digest、相同 digest 跨 scope、不同前驱或签发版本冲突一律拒绝并隔离，**不能覆盖已有证据**。
- 两个进程从同一旧 cursor 并发写入，只能有一个成功前进；失败方重读权威 cursor 后冲突拒绝，不能静默重写链。
- 数据库提交结果未知（例如响应丢失）时以严格 semantic identity 查询判断已提交/未提交，然后安全重试；不得靠覆盖 cursor 或猜测 commit 成功。
- 缺序号、失联、签发中断、时钟倒退、超过 15 分钟的静默、reboot/new session 及 observer 自身停机必须产生不可逆的 `UNKNOWN/GAP` 区间，不能靠事后 baseline 清除。
- 时间线同时保留签发时间、观察时间及数据库接收时间；系统时钟或延迟记录本身不构成采集连续性，外部 anchor 与版本/UTC 边界须单独检查。
- 需要实测跨连接的 `READ COMMITTED`/显式锁与恢复语义，或选择隔离级别更高的替代方案并论证活锁、重试预算；不允许在数据库事务内处理宿主机、注册签发服务或异地锚的网络请求；任何跨系统失败必须留下未知区间，不得把无确认当作连续。

此方案只会把**已认证来源的已接收记录**变成可核验的持久历史。即使 CAS 完全通过，也不能推出宿主机 inventory 完整或业务事件从未遗漏。

## 5. 完整成员清单、采集开关及源数据对账

成员权威必须来自与应用自报分离的编排/基础设施 inventory，提供包含零实例时间、启动/停止/滚动发布 epoch、exact release SHA、应用与 async-worker 的观测覆盖。已签收而未曾出现在 inventory 的主机不得计入完整部署。

每个 host/workload/stream 的**历史有效开关 epoch**需要独立记录，不能用当前 `.env`、健康探针、feature flag 或 receipt 数量倒推过去。必须将 `LISTING_CREATED`、`CONVERSATION_CREATED`、`FIRST_REPLY`、`ORDER_ATTRIBUTION`、`PROJECTION_WORKER` 五个流对齐到 7/30 天 cohort + 7 天归因尾部；遗漏/禁用/滚动发布重叠/迟到事件均使对应范围 unavailable。

对账必须以真实 source-of-truth 业务事务/DomainEvent 与投影 receipt 为两个分别核查的集合，进行 campus-scoped、有界、可复演的差异分析；`projectionMissing=0` 只说明已观测事件投影齐全，不能反证源端根本没有漏发。需要明确不可能凭单一来源证明的盲区，交由独立演练和残余风险决策。

## 6. 分层验收矩阵与明确 STOP 门

| Gate | 必须提交的独立证据 | 失败时行为 |
| --- | --- | --- |
| G1 注册根 | 运维签发/钉住/吊销的独立审批和活跃版本；key/host/workload 对应 | 未签发 / 任意替代 key / 旧 epoch → DENY |
| G2 独立观察 | 实际受限主体、权限清单、host inventory 对账，不能访问应用密钥或 DB owner | observer 没有独立性 → NOT VERIFIED |
| G3 持久 CAS | 真实 PostgreSQL 两事务竞争、重放、冲突、崩溃/提交结果未知和恢复测试 | 分叉或中断 → QUARANTINE/GAP |
| G4 历史成员 | 零实例、滚动部署、重启、失联、补发和完整清单复演 | 任一未知区间 → UNAVAILABLE |
| G5 源事件 | 每个 campus 与五流的 source/receipt/开关 epoch 逐窗对账与漏发演练 | 不完整 → UNAVAILABLE |
| G6 发布准入 | 全新独立 PR、签署发布风险决策、真实生产样本演练和 exact-master CI | 未授权 → canPublish=false |

建议的最小对抗测试：两个并发不同 hash 争抢同一 slot；多进程重启回放；有效签名但未经批准的主体；吊销/回滚的 key epoch；异常中断和未知 commit；独立观察者停机或漏报；inventoried 与真实启动成员不一致；跨校园拼接；漏掉 SOURCE 但保留全部 projection receipt；伪造运营审计字段；主机/密钥信息不泄露到校园管理员输出。明确分别用 unit、real-PG 和外部 fault drill，不互相替代。

## 7. 实施依赖与决策点

依赖顺序：**外部运营签发/部署 inventory/受限采集能力的选型和所有权确认 → 只读验证器与签发快照 → 分权凭据与持久 CAS → 独立宿主机观察与外部日志锚 → 历史清单/开关事实 → 业务源数据对账 → 独立发布审批**。

1. **本切片交付：** 冻结此安全 ADR、列明不可由现有仓库自证的依赖，定义事务与灾难恢复验收；没有秘密注入、HTTP ingress、部署服务、自动采集、持久化 migration 或信任标志变更。
2. **下一实现 PR 的入口条件：** 运维实际确认 root custody、可信安装、主机/编排平台、最小权限观测方式和独立 datastore/anchor。若这些不可得，优先实现保持 `UNVERIFIED` 的有限事务安全增强，但绝不将其描述为 G1–G5 通过。
3. **明确不在本阶段：** 不在 Compose 添加裸 Docker socket、不开源/生产采集开关、不新增公开 dashboard 指标、不修改 `loadAuthorizedFunnelDiagnostic` 为可发布、不赋予 app/worker 发行 observer key 的权限。

资源与风险预算：操作必须有界、可去重、可观测且不写原始个人信息；具体 CPU/内存/网络、日志保留和业务延迟 SLO 在选定实际运维拓扑后测量冻结，不能凭空声明已达标。

## 8. 生产不变量与 PR 验收

所有候选结果仍固定：

```text
independentProvisioningVerified = false
independentHostAuthenticated = false
deploymentMembershipComplete = false
captureContinuityProven = false
canPublish = false
```

此文件的架构审批**不得**自行修改这些标记或启动生产功能；架构同意也不等于部署/发布批准。原有 `analytics.read` 校区权限、5000 条诊断上限、不可用而非 0 的返回语义保持原状。

PR 仅新增本 ADR 文件。须新分支、DRAFT PR、exact-HEAD Verify/Playwright 双绿、独立风险复核和用户明确授权才能合并；Merge Commit 要检查 expected head、两个 Parent、master HEAD 与 exact-master-SHA CI。Issue #97 仍单独 OPEN，不因 CI 绿而关闭。
