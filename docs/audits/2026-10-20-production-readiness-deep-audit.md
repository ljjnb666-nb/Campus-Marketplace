# Campus Marketplace 深度审计与上线评估

审计日期：2026-10-20（Asia/Shanghai）。

**结论：当前不建议直接正式公开上线，也不能认定为成熟的交易网站。更准确的定位是“工程基础较强、功能覆盖较广，但仍需交易正确性修复和生产验收的校园线下撮合产品”。未接入微信/支付宝不是唯一原因，也不是线下撮合模式的独立否决项。**

## 1. 审计对象与证据边界

- 仓库：<https://github.com/ljjnb666-nb/Campus-Marketplace>。
- 基准：GitHub 默认分支 `master`，精确提交 [`0f7e51aa54fd57441f59d90db632cb96a47b44f4`](https://github.com/ljjnb666-nb/Campus-Marketplace/commit/0f7e51aa54fd57441f59d90db632cb96a47b44f4)，提交时间 2026-10-18。
- 本地原工作区是旧修复分支 `fix/prisma-soft-delete-fail-closed`，含既有未跟踪内容；另一个历史审计 worktree 也不是最新 master。本轮未用它们代表当前主干。
- 从上述精确提交导出隔离源码快照，在 `.tmp-scratch/audit-2026-10-20/source` 审计。没有切换用户分支、覆盖既有工作、创建 worktree、修改业务源码或远程发布。
- 同时审阅交易状态机、鉴权/RBAC、存储与隐私、部署恢复/异步任务、核心用户界面、依赖和当前 GitHub CI。
- 截至检查时，租赁相关 Draft PR #175–178 及 Prisma 相关改造仍未合并。未交付的修复没有算进 master 能力。
- 本机 Docker daemon 不可用。本轮没有启动生产服务、修改真实数据库、执行真实支付、进行外网渗透、重跑本地全量实库并发/E2E 或测量生产容量。真实 PostgreSQL/Redis/MinIO 和浏览器全量证据来自下述精确提交 CI。

本报告将“当前代码可证实问题”“能力缺口”“缺少生产证据”分开。P1 表示建议在对应功能正式开放前修复；P2 表示应安排修复的正确性、运维或安全缺口。没有因为扫描显示 high/critical 就推断存在公网可利用攻击。

## 2. 实际验证结果

### 精确提交 GitHub Actions

[CI run 39095943544](https://github.com/ljjnb666-nb/Campus-Marketplace/actions/runs/39095943544) 对应上述完整 SHA，两个 job 均 completed / success：

| 检查 | 实际结果 |
| --- | --- |
| Lint / Typecheck / production build | PASS |
| 数据库迁移首次执行与幂等重跑 | PASS |
| Vitest | **527 文件 / 4729 用例 PASS，0 failed** |
| 覆盖率 statements / branches / functions / lines | **89.36% / 86.88% / 91.37% / 89.36%** |
| Playwright | **107 PASS，输出无 flaky / failed / skipped 汇总项** |
| 集成依赖 | CI 配置并运行 PostgreSQL、Redis、MinIO |

这些是工程可靠性的有力证据，但不是本次发现的新竞争场景、真实生产部署或安全扫描通过的证明。README 中较旧的 4028/93 等数字不用于本报告。

### 本轮本地验证

| 检查 | 结果与含义 |
| --- | --- |
| 隔离快照安装 | `npm ci --ignore-scripts --no-audit --no-fund` 成功；未自动执行依赖生命周期脚本 |
| Prisma Client | 显式 generate 成功，6.19.3，使用不可连接的合成数据库地址 |
| 现有定向回归 | **7 文件 / 180 用例 PASS，0 failed**；认证、server-auth、租赁领域/action、会话 repository 与组件 |
| 新增交易/界面复现 | **4 文件 / 10 用例 PASS，0 failed** |
| 新增上传复现 | **2 文件 / 2 用例 PASS，0 failed** |
| 部署 SHA 复现 | 原始 Bash helper + 仅打印的 Docker 替身，确认构建时 GIT_SHA 进入子进程，迁移时没有 |
| `npm audit --omit=dev --json` | **3 high，0 critical，退出码 1** |
| `npm audit --json` | **26 条：3 critical / 14 high / 9 moderate，退出码 1** |

**新增 12 个测试的 PASS 表示成功重现当前问题，不表示问题已修复。** 领域与存储复现调用真实源码函数，数据库/网络边界使用隔离适配器；UI 复现渲染真实组件。它们没有替代真实数据库锁竞争、完整浏览器验收或真实 S3 负载测试。

本地原始证据位于 `../../.tmp-scratch/audit-2026-10-20`：

- [CI 元数据](../../.tmp-scratch/audit-2026-10-20/ci-status.json)、[完整 CI 日志](../../.tmp-scratch/audit-2026-10-20/ci.log)。
- [180 条定向回归日志](../../.tmp-scratch/audit-2026-10-20/focused-regression.log)。
- [10 条交易/聊天复现日志](../../.tmp-scratch/audit-2026-10-20/reproductions.log)、[2 条上传复现日志](../../.tmp-scratch/audit-2026-10-20/security-repros.log)。
- [生产依赖扫描](../../.tmp-scratch/audit-2026-10-20/npm-audit-production.json)、[全依赖扫描](../../.tmp-scratch/audit-2026-10-20/npm-audit-all.json)。
- [迁移 SHA 复现脚本](../../.tmp-scratch/audit-2026-10-20/deploy-migrator-sha-repro.sh)、[输出](../../.tmp-scratch/audit-2026-10-20/deploy-migrator-sha-repro-output.txt)。

## 3. 正式开放前优先修复的问题

### F01 / P1：租客取消可能被出租者旧审批重新激活

代码：[rental-order-machine.ts:349](https://github.com/ljjnb666-nb/Campus-Marketplace/blob/0f7e51aa54fd57441f59d90db632cb96a47b44f4/src/lib/rental-order-machine.ts#L349)、取消路径同文件 641–669。

审批/拒绝先读取 `PENDING_APPROVAL`，随后用仅含 ID 的 UPDATE。它们只持当前 owner 的 USER 锁；renter 取消持的是另一用户锁和订单行锁。存在如下时序：

1. owner 读到待审批申请，尚未写入；
2. renter 取消并提交；
3. owner 用旧快照批准，状态被写回 `PENDING_PICKUP`。

受控函数复现中，订单恢复待取货，却仍保留 `cancelledAt`、取消者和取消原因，同时生成相互矛盾的日志与通知。拒绝也能覆盖取消结果。

**影响是取消失效与记录冲突；本报告没有据此断言超售。** 修复应统一订单行锁、锁后最新状态检查和状态 CAS，并证明只有有效赢家写日志/通知。验收必须包含真实 PG 双用户竞争；Draft #175 不能替代 master 修复。

### F02 / P1：后一方确认可以改写前一方的交接证据

代码：[rental-order-machine.ts:456](https://github.com/ljjnb666-nb/Campus-Marketplace/blob/0f7e51aa54fd57441f59d90db632cb96a47b44f4/src/lib/rental-order-machine.ts#L456)、归还记录 569–595。

取货时 owner 已确认的照片、物品现状，随后被 renter 的照片和描述替换；两人的确认标记却仍为真。顺序调用即可复现，无需并发。

归还领域函数也允许后提交的 renter 改写 owner 的 `hasDamage`、配件情况、验收备注和照片。当前普通页面另有 F03 缺口，但授权参与者直接调用 action 的领域边界仍需正确。

原文件可能还在对象存储，本问题是业务证据引用与事实被覆盖，不能等同“文件永久删除”。应按提交者保存不可覆盖的事实/版本或追加证据，避免另一方确认隐含批准了被改写的内容。

### F03 / P1：正常归还页面无法进入损坏验收与索赔分支

代码：[return/page.tsx:39](https://github.com/ljjnb666-nb/Campus-Marketplace/blob/0f7e51aa54fd57441f59d90db632cb96a47b44f4/src/app/rental-orders/%5Bid%5D/return/page.tsx#L39)、[rental-order.ts:335](https://github.com/ljjnb666-nb/Campus-Marketplace/blob/0f7e51aa54fd57441f59d90db632cb96a47b44f4/src/actions/rental-order.ts#L335)、领域函数 597–610、claim 页面 20–24。

真实表单只有照片和备注，没有 `hasDamage`、`needsCleaning`、`accessoriesComplete`。Action 将缺失字段全部解析为 false。

因此出租者即使备注“外壳破损，需要索赔”，正常提交仍被认作无损坏并进入 `COMPLETED`，且配件情况记录为 false。索赔页只接受 `PENDING_INSPECTION`，正常验收入口无法到达该分支。归还页自身还会把 `PENDING_INSPECTION` 重定向出去。

已通过真实页面和真实 `RentalActionForm` DOM 提交复现。应补明确的验收选择、角色权限和状态分流，并用浏览器完整走通完好、损坏、配件缺失、索赔及复查流程。

### F04 / P1：上传数量校验晚于上传，直接 Action 可绕过 API 限流

代码：[product.ts:43](https://github.com/ljjnb666-nb/Campus-Marketplace/blob/0f7e51aa54fd57441f59d90db632cb96a47b44f4/src/actions/product.ts#L43)、租赁 `rental-listing.ts:32-60`、上传 route 101–105。

兼容直传文件的 Server Action 先对所有文件执行 `Promise.all(uploadImageAsset)`，之后才检查最多 9 张图片。上传 API 的每分钟限制没有覆盖这些直接调用。

真实 `createProduct` 隔离复现：提交 25 个小文件，调用上传服务 25 次，随后返回“最多上传 9 张图片”，限流调用为 0，商品业务事务为 0。

这使失败表单仍能消耗图片解码、重编码、对象存储与孤儿清理资源。已有请求体上限和账号配额，因此不是“无限上传”证明；实际服务降级阈值未测。

应在所有副作用前检查文件数量/总预算，将限流下沉到所有入口共享的服务边界，并限制并发；数量超限必须零上传。

### F05 / P1：部署迁移没有绑定本次发布镜像

代码：[deploy.sh:124](https://github.com/ljjnb666-nb/Campus-Marketplace/blob/0f7e51aa54fd57441f59d90db632cb96a47b44f4/scripts/ops/deploy.sh#L124)、131/134；`lib.sh:102-104`；`compose.production.yml:96`。

构建时使用 `GIT_SHA="${GIT_SHA}" compose_run build ...`，两次迁移执行却未传该环境变量。脚本中的普通赋值不自动 export；默认配置又期待 deploy 传入 SHA。真实 Bash 复现确认迁移子进程没有 GIT_SHA。

因此，在调用方没有提前 export、env 文件没有另行指定时，Compose 会解析 `campus-marketplace-migrator:local`，可能重用旧迁移镜像或构建非本次 SHA 标签镜像。旧镜像也可以报告自身“No pending migrations”，而新 app 需要的迁移尚未执行。

应对所有迁移调用显式绑定 SHA，并验证解析后和实际运行的镜像身份。回归必须覆盖没有预设 GIT_SHA、遗留旧 local 镜像的部署环境；现有无条件成功的 Docker stub 未覆盖此点。

### F06 / P1：回滚把 cleanup 镜像缺失误判为旧版本无需 worker

代码：[rollback.sh:73](https://github.com/ljjnb666-nb/Campus-Marketplace/blob/0f7e51aa54fd57441f59d90db632cb96a47b44f4/scripts/ops/rollback.sh#L73)、170–187。

若目标 cleanup 镜像在本机不存在，代码直接判为 `pre-worker`，停止当前 cleanup，随后仍可能完成回滚。镜像被清理不等于该版本原本没有 worker。

结果是删除重试、孤儿清理及保留期维护持续停止，直到运营人员介入。相邻 async-worker 分支已从目标 Git commit 验证服务是否存在，并在缺镜像时拒绝回滚，cleanup 未采用同等保护。

该项由源码直接确认，未执行真实 Docker 回滚。应依据不可变发布清单/精确 commit 判断拓扑，目标本应包含服务而缺像时，在任何生产副作用前拒绝。

### F07 / P1（聊天可用性）：历史消息无法加载，补接后游标仍会漏一条

代码：[conversation-layout.tsx:84](https://github.com/ljjnb666-nb/Campus-Marketplace/blob/0f7e51aa54fd57441f59d90db632cb96a47b44f4/src/components/conversation/conversation-layout.tsx#L84)、[chat-message-list.tsx:56](https://github.com/ljjnb666-nb/Campus-Marketplace/blob/0f7e51aa54fd57441f59d90db632cb96a47b44f4/src/components/conversation/chat-message-list.tsx#L56)、API `messages/conversations/[id]/route.ts:23-24`、repository 437–452。

- repository 默认只返回最近 20 条。
- UI 展示“查看更多历史消息”，父组件没有传 `onLoadMore`；点击无请求、无刷新。
- API 也没有将请求中的 cursor 传入 repository。
- repository 将额外取出的、尚未展示的那条消息作为 `nextCursor`，下一页却又 `skip: 1`。两页调用复现中，5 条消息只展示 4 条，中间消息被永久跳过。

对交易网站而言，旧沟通包含交付约定和争议背景，应修复后再把聊天作为可靠履约入口。需要 UI → API → repository 全链路分页测试，以及不漏不重、相同时间戳稳定排序的真实数据库验证。现有组件测试手动注入回调，repository 测试仅断言第一页，未覆盖这两个断点。

## 4. 其他已确认风险与待完善项

| 编号 | 等级 | 证据与影响 | 建议 |
| --- | --- | --- | --- |
| F08 | P2 | 同一订单可连续创建多条未决损坏索赔；处理一条后订单完成，其余无法继续处理。`rental-order-machine.ts:1157-1183`，schema 1511–1526。已复现两次都成功。 | 为未决索赔定义唯一性/幂等与撤销收敛；不能据此说已存在重复扣款，响应已有 CAS。 |
| F09 | P2 | 上传通过旧鉴权后，账号擦除先提交，raw 配额 SQL 只按 ID/空间检查；后续仍能创建带原文件名的 PUBLIC 资产。`asset-service.ts:159-170,264-296,373-376`。已隔离复现。 | 与账号擦除共享登记/终结边界，失效则清 filename 并排队删除。当前默认 24h 孤儿清理限制残留，不是永久泄漏/账号复活证明。 |
| F10 | P2 | 登录按邮箱统一 10 次/15 分钟限流，验证密码前拒绝；陌生请求可耗尽受害者窗口，换邮箱则换桶。`auth.ts:11-12,35-41,66-75`。 | 结合来源、账户、风险分层预算与渐进退避；生产 WAF 情况另验。未进行在线攻击。 |
| F11 | P2，跨版本升级触发 | 新 app 先上线，旧 async-worker 到 deploy 217 行才替换；旧 runner 对未知 kind/schemaVersion 永久失败入死信，见 `job-runner.ts:119-135`。 | 暂停旧消费者或建立向前兼容的两阶段发布。不是每次部署必现，也不是不可恢复；升级新 worker 后需人工 requeue 才能恢复这些任务。 |
| F12 | P2，容量风险 | 消息摘要 `findMany(distinct:["conversationId"])` 注释称 SQL DISTINCT ON，但 schema 未启用 nativeDistinct；Prisma 6 默认在内存去重。相应查询没有按每会话限制历史行，聊天每 4 秒还触发页面 refresh。 | 改为真实数据库每组最新一条查询/摘要权威，并对真实历史规模与活跃聊天压测；没有据此编造承载人数或停机阈值。 |
| F13 | P2，移动端导航 | `/messages` 默认选择第一会话；窄屏有 activeId 时隐藏会话列表；“返回”又导航到 `/messages`。源码显示会重新选中第一会话，缺少稳定的纯列表状态。 | 增加独立移动列表状态；用真实手机尺寸浏览器验证多会话切换。本轮仅静态核验。 |
| F14 | P2，发布证明 | app 的 RELEASE_SHA 来自镜像 ENV，可被 compose env_file 覆盖；health/ready 回显进程环境。worker 有 `.release-sha` entrypoint 防覆盖，app 没有。 | 发布验收同时验证镜像身份与不可变构建标识，不能只信 health 字符串；这是误配置防线缺口，不是外部身份绕过漏洞。 |

F12 的 Prisma 行为依据：[Prisma ORM v6 官方说明：distinct under the hood](https://docs.prisma.io/docs/orm/v6/prisma-client/queries/aggregation-grouping-summarizing)。该说明支持查询处理方式判断，不提供本项目的生产性能数据。

## 5. 未接支付意味着什么

### 可以成立的业务模式

如果平台明确只负责发布、沟通、预约、履约记录、评价与争议协助，双方线下验货和付款，那么不接微信/支付宝支付接口也可以形成完整产品。其上线前提仍包括账号、交易正确性、客服、隐私和生产运维的验收。

当前首页安全提示已说明第一版线下付款；这是一项合理边界。但租赁局部状态和文案尚未一致遵守这个边界。

### 当前不是可直接收款的支付系统

在生产源码中，各类新订单写 `OFFLINE_PENDING`；没有发现由真实支付通知/对账驱动的支付状态更新。租赁完成时只看押金金额就写 `PENDING_REFUND`，同意索赔则直接写 `PARTIALLY_REFUNDED`。

本轮复现得到：未支付押金为 100 元，同意扣除全部 100 元后，记录为：

```text
订单 COMPLETED
paymentStatus OFFLINE_PENDING
depositStatus PARTIALLY_REFUNDED
depositDeduction 100
```

这只能证明业务代码改变了字段，不能证明收款、扣款或退款发生。索赔页还写“租客确认后将从押金中扣除相应金额”。正式线下模式应把这些改为明确的协商/线下确认语义，避免让用户理解为平台已托管或退还资金。

技能服务也只复制 listing 单价作为订单 amount，没有完整计价单位、购买数量/时长和协商总额合同。已有完成事件代码因此排除 SERVICE 的交易价值贡献，这个保守处理正确，但不能将当前 amount 直接当未来结算额。

上线在线支付至少还需独立验收：

- 订单与支付、退款分别建模；真实金额/币种/商户订单绑定。
- 验签、重复和乱序通知、幂等处理、主动查单，以及支付成功与关单竞争。
- 不可变资金流水、部分/全额退款、退款失败与补偿、押金和赔付事实。
- 按实际业务模式对接持牌渠道支持的收款/分账/结算方案。
- 对账、差错处理、退款争议、权限与操作审计。

这不是现在建议立刻开始的支付开发任务。既有 ADR 明确先完成非支付产品与受控试点；本报告认可这一顺序。

## 6. 账号、安全依赖与生产运营缺口

### 账号生命周期尚不足以面向普通用户长期运营

没有查到邮箱所有权验证、忘记密码、安全改密、用户会话/设备管理、撤销单个/其他会话，以及管理员 MFA/等效二次认证。

现有 JWT 七天有效，并且每个主要业务边界重读账号 ACTIVE/deletedAt/erasedAt。停用或注销可使旧令牌失去业务权限，这是已有保护；它不能替代用户丢失密码后的恢复或泄露会话后的主动撤销。

这些也是 [ADR 0002](https://github.com/ljjnb666-nb/Campus-Marketplace/blob/0f7e51aa54fd57441f59d90db632cb96a47b44f4/docs/adr/0002-non-payment-production-completion.md) 明确要求的非支付上线能力。它们是功能和安全成熟度缺口，不应全部包装成已被利用的漏洞。

### 依赖扫描没有通过安全放行

本轮实时扫描生产依赖报告 3 条 high，来源是 **同一 deepmerge-ts → @prisma/config → prisma 链**，不是三个独立公网攻击入口。全依赖扫描总计 26 条记录，包含上述生产链。

Dockerfile 的 cleanup-runner 复制完整 node_modules，async/ops 又从它继承；这些 worker 的源码构建定义也没有 `USER node`，与 web runner 的非 root 配置不同。需要按实际镜像区分构建工具、CLI、worker 和 web 可达性，并缩小长期运行的包与权限范围。

已存在 [Issue #157](https://github.com/ljjnb666-nb/Campus-Marketplace/issues/157) 和未合并改造。应修复或形成具体、审阅过的可达性与风险接受记录；不能直接强制升级 Prisma 主版本，也不能以功能 CI 全绿宣称安全扫描全绿。本轮未构建镜像，因此没有将 lock 扫描冒充实际镜像 SBOM/运行时利用验证。

### 运维脚本丰富，但生产保障仍待实证

已有 readiness、指标、任务状态、数据库备份/checksum、回滚与恢复脚本、故障注入和压测脚本。并不是完全没有运维设计。

同时：

- 路线图仍明确 `PRODUCTION_LAUNCH_BLOCKED = TRUE`，真实 Phase 3B 部署 deferred；没有提供本次可核验的生产域名/服务器/发布记录。
- `docs/ALERTING.md:3-4` 明确真实告警渠道尚未接入；编写阈值不等于有人收到故障通知。
- Compose 提供单机 app/PostgreSQL/Redis 和可选自建 MinIO，也支持外部 S3；本地服务没有据此获得复制、自动故障转移或零停机能力。
- PostgreSQL dump 和 checksum 已有实现；异地副本是可选配置，对象存储复制/备份仍需外部配置与恢复证据。
- 本轮没有找到可证明实际运行的无人值守备份调度、明确并实测的 RPO/RTO、生产同规格恢复时长及 DB+对象存储联合恢复记录。
- 现有压测包含历史本机结果，不能转换为当前生产可承载用户数；尤其不能只用首页/搜索压测推断下单、聊天和上传容量。
- 运营主体、适用的部署/备案要求、隐私文本与实际数据流一致性、校园授权/规则、违禁交易处置、客服排班和紧急联系人都需要实际负责人核验。本报告未据仓库文件宣称这些已满足。

### 分析指标有实现，但可信生产证明仍未关闭

最新 master 已有搜索、漏斗、归因和相关证明代码；不能照搬 10 月 8 日旧审计说这些完全不存在。当前部分 funnel proof/publish flags 仍固定为 false，例如 `funnel-host-lifecycle-contiguous-unverified.ts:37-52`。

这意味着不能把未认证候选数据当可信生产 KPI 发布。G1–G6 是该分析专项的证明门，不能混称全站交易授权门。路线图文档存在历史快照与滞后状态，缺陷结论以上述源码与实际验证为准。

## 7. 已有能力与成熟度判断

| 维度 | 当前评价 |
| --- | --- |
| 商品/跑腿/服务/租赁覆盖 | 功能面广，基本协作链路存在；租赁例外与聊天历史仍有断点 |
| 数据正确性 | 二手预留、跑腿 Task/Order 双 CAS、租赁区间峰值容量等有实质设计；尚不能推定所有动作都共享正确并发边界 |
| 治理与权限 | RBAC/校区 scope、举报、申诉、争议、数据 hold、审核与审计较完整 |
| 存储与隐私 | 公私隔离、私密资源逐次鉴权、图片重编码/EXIF 剥离、配额、清理重试、导出与擦除已有实现；上传入口和生命周期边界仍待修复 |
| 评价信任 | 参与者校验、双盲/时间窗口、争议期间隐藏与统一可见性策略已有实现 |
| 自动化验证 | 覆盖率门槛、实库集成与关键路径 E2E 基础较好；当前测试仍遗漏用户真实操作组合 |
| 普通账号体验 | 恢复、改密、会话管理和强认证缺失，未达到正式运营完整性 |
| 真实支付 | 未实现支付与资金闭环；当前财务字段不能充当真实资金凭证 |
| 部署与持续运营 | 有工具链；存在发布/回滚缺陷，真实部署、监控和恢复验收未证明 |
| 产品成熟度 | 本轮未取得可核验的受控试点结果、有效成交、纠纷率、响应时间和稳定运营数据，不能证明商业成熟 |

“成熟交易网站”需要在正常路径之外，让取消、争议、失败、重试、账号丢失和服务器故障都能得到可靠且可解释的结果。目前项目在这些边界仍有明确缺口。

## 8. 建议的上线顺序和验收条件

1. **先修交易正确性与部署阻断。** 完成 F01–F07，以及线下押金语义；为每项建立真实入口回归，跨 actor 竞争用真实 PostgreSQL barriers。不要把可演示的 happy path 当成完整验收。
2. **补齐非支付账号闭环。** 邮箱证明、恢复/改密、令牌失效与会话撤销、管理员加强认证、账号安全邮件和异常操作记录。
3. **关闭供应链风险与生产部署证据。** 对实际 release 镜像审计包/权限，修复迁移/回滚/worker 切换，验证隔离环境升级与回滚。
4. **做与正式配置一致的预发布演练。** 实际 TLS、私密桶、共享限流、worker、告警送达、定时异地备份、空环境 DB+对象恢复、回滚后的任务恢复。定义可以接受的数据损失窗口与恢复时长后再实测。
5. **通过上述门禁后开展单校园邀请制、限量线下撮合试点。** 明确平台不托管资金；客服可响应；异常能暂停新单；收集成交、取消、纠纷、恢复和可用性数据。观察期与规模由真实容量和运营资源决定，不凭代码量指定人数。
6. **用试点数据决定在线支付与更大范围开放。** 正式收款另做支付域和对账验收；最终以精确发布 SHA 的完整 CI、生产配置和实际演练结果重新审计。

当前建议保持内部开发/测试状态。修完关键问题并取得生产证据后，可以重新评估“受控非支付试点”；在此之前，不建议直接向全校公开推广，更不能承诺托管、自动退款、稳定结算或平台资金保障。

## 9. 复现范围与避免误判

- 没有把 Draft PR 中受控 SQL 对手等同真实生产调用链：真实纠纷入口会先锁双方 USER，可能已阻断部分表面竞争；因此未把这些未经验证的竞争重复列为漏洞。
- 没有把重复索赔说成重复扣款，也没有把取消复活说成已经证明超售。
- 没有把邮箱缺少验证、MFA、支付接口等所有功能缺口都标成安全漏洞。
- 没有将有限期在途上传残留宣称为永久数据泄漏。
- 没有将扫描包名记录当独立漏洞数，或将未安装进 web runtime 的开发工具自动判为公网攻击面。
- 没有用历史审计的“仍未修复”结论替代当前源码复核。
- 完整业务源码保持原状；新增内容仅为本报告、隔离复现脚本、源码快照和验证日志。
