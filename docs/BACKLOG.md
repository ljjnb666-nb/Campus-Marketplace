# BACKLOG（非阻塞债务 / Backlog 登记）

> 登记规则（MASTER_ROADMAP §11 同款语义）：出现以下问题默认进入 BACKLOG，
> 而不是立即插入现有 Phase。条目必须包含 title / motivation / priority /
> dependency / candidate phase / blocker 状态。
> **本文件不建立新的 canonical Phase。**

---

## P7-DEBT-E2E-SETUP-01

- **title**：E2E wipeAll deletion-order weakness
- **motivation**：`scripts/e2e-setup.ts` 的 `wipeAll` 中
  `listingModeration.deleteMany()`（L135）晚于 `product.deleteMany()`（L93）。
  被中断的 dirty 本地 E2E 运行可能遗留 ListingModeration 行，导致后续
  `npm run e2e:setup` 在 Product 删除时触发
  `ListingModeration_productId_fkey` FK 失败（2026-09-21/22 本地实测多次）。
- **priority**：MEDIUM
- **dependency**：E2E infrastructure（scripts/e2e-setup.ts）
- **candidate phase**：Phase 8
- **review_at**：Full-System Adversarial Audit / pre-Phase 8
- **blocker**：NON_BLOCKING for Phase 7
- **CI IMPACT**：NOT ESTABLISHED——fresh CI DB 无残留行，不受影响

---

## P7-DEBT-E2E-LOAD-01

- **title**：local high-load distributed E2E timeout flakes
- **motivation**：本地高负载（连续 stress / coverage 双重插桩 / 累积
  chromium 实例）下，无关测试出现散布的 90s timeout / goto 中止 /
  "worker IPC channel closed" 类失败；同批次隔离复跑与 fresh exact-head
  CI 均保持稳定（Phase 7H 期间多次实测记录）。
- **priority**：MEDIUM
- **dependency**：E2E infrastructure / local resource scheduling
- **candidate phase**：Later
- **review_at**：Full-System Adversarial Audit
- **blocker**：NON_BLOCKING for Phase 7
- **PRODUCTION_IMPACT**：NOT ESTABLISHED

---

## P7-BACKLOG-LEGACY-MAINT-01

- **title**：Retire remaining /admin categories and keywords maintenance surfaces
- **motivation**：canonical operations console 是 `/governance`，但两个
  legacy 维护页（`/admin/categories`、`/admin/keywords`）仍存在于 /admin
  子树（requireAdmin 桥 + `category.manage` / `moderation.keyword.manage`）。
- **priority**：MEDIUM
- **dependency**：`category.manage` / `moderation.keyword.manage` 既有 permission
- **candidate phase**：Phase 11
- **review_at**：Phase 11 planning / pilot operational-readiness cleanup
- **blocker**：NON_BLOCKING for Phase 7

---

## AUDIT_DEBT_RENTAL_AVAILABLE_QUANTITY

- **title**：`RentalListing.availableQuantity` 是 stale 的一次性写入投影
- **motivation**：Full-System Audit Repair 1（RB-02）确认：当前权威容量
  判定 = `totalQuantity` + 重叠 RentalOrder 的 `quantity` SUM
  （`checkTimeConflict`，真实 PostgreSQL 并发测试
  `tests/integration/rental-capacity-invariant.test.ts` 证明）。
  `availableQuantity` 仅在 listing 创建时写入一次（= totalQuantity，
  `src/actions/rental-listing.ts`）与 seed（= 1），此后从不随订单生命周期
  更新，也无任何业务读取——不参与容量判定。禁止将其升级为第二套
  authoritative inventory（租赁是时间窗库存，全局计数器语义不成立）。
- **priority**：LOW
- **dependency**：RentalListing schema lifecycle
- **candidate phase**：Phase 8
- **review_at**：Phase 8 planning / listing lifecycle review
- **blocker**：NON_BLOCKING（字段不被读取，无正确性影响）

---

## AUDIT_DEBT_LEGACY_UPLOADS_PUBLIC_DIR

- **title**：`public/uploads/` 仍是公开静态目录（历史本地上传姿态）
- **motivation**：Full-System Audit Repair 2（RB-01）runtime + data closure
  已保证历史认证证据值不再被渲染为可点击链接（migration
  `20260923120000_repair2_verification_evidence_closure` 清空 DB 引用 +
  `PrivateAssetViewer`/读模型 fail-closed）。但 `public/uploads/` 目录本身
  仍被 Next 静态服务（`src/proxy.ts` matcher 显式排除 `/uploads`），
  其下历史文件（如旧头像）保持公开可直达。文件级 posture（目录退役 /
  存量对象迁移到私有桶）属于存储生命周期治理，非认证证据引用问题。
- **priority**：LOW
- **dependency**：storage lifecycle / proxy matcher
- **candidate phase**：Phase 8
- **review_at**：Phase 8 planning（与 RB-04 privacy lifecycle 同批）
- **blocker**：NON_BLOCKING（无证据表明其下存在学生证类材料；本地实测
  仅头像/占位文件）
- **RB-06 FINAL-03 补充（2026-09-25）**：`.dockerignore` 已排除
  `public/uploads/*`（negation 保留 tracked placeholder 资产），本地/遗留
  上传文件不再进入 production Docker build context（动态 canary probe 见
  `tests/ops/docker-context-provenance.test.ts`）；主机侧存量文件的
  inventory/quarantine 仍属本条既有 debt。

---

## AUDIT_DEBT_PHASE7H_CRACE06_CI_FLAKE

- **title**：phase7h C-RACE-06 方向 A 在 CI 并行负载下的偶发时序抖动
- **motivation**：Repair 4 PR #32 的 CI run 35992495910 attempt=1 中
  `phase7h-operations-campus-admin.test.ts` C-RACE-06 方向 A
  （registration 先取得 CAMPUS 锁 → 注册提交 → 停用随后提交）以 124ms
  断言失败（`outcome.ok` undefined），attempt=2 同 SHA 双绿（verify + e2e）。
  该测试域为 registration × suspension 生命周期，与 RB-04 privacy
  lifecycle 变更零接触（两次 CI 之间该文件仅改一行注释；本地 coverage
  全轮与前一 CI run 同文件全绿）。race 类测试在共享 CI runner 的
  调度抖动下偶发违背 barrier 时序假设，与本仓库已知
  "CI 跨文件并行 flake（重跑即绿）"同类。
- **priority**：LOW
- **dependency**：phase7h race fixture（lock barrier 时序假设）
- **candidate phase**：Phase 8（测试基建稳定化批）
- **review_at**：Phase 8 planning
- **blocker**：NON_BLOCKING（attempt=2 同 SHA 双绿；本地隔离全绿）

---

## CI_DEBT_MINIO_MIRROR_MUTABLE_TAG

> **状态**：已关闭（2026-09-25，Repair 6 / RB-06）。CI 与生产 compose 的
> MinIO/mc 镜像全部改为 immutable digest pin（`tests/ops/image-immutability.test.ts`
> 静态 gate 防回退），镜像更新流程见 docs/PRODUCTION_DEPLOYMENT.md §3.2。
> 以下为登记时的原始记录。

- **title**：CI 的 ghcr MinIO 镜像副本使用可变 `latest` tag
- **motivation**：RB-04 FIELD-COVERAGE round（run 36033918738 起）CI 的
  MinIO/mc 镜像源切换到 `ghcr.io/ljjnb666-nb/minio|mc:latest`（官方镜像
  副本，解决 quay.io 匿名 401 与 Docker Hub runner-IP 限流）。`latest`
  是可变 tag：副本与上游 MinIO 版本不会自动同步，镜像更新需维护者手动
  重新 push；且无 digest pin，理论可变但持有者是唯一 pusher。
- **priority**：LOW
- **dependency**：ghcr packages（ljjnb666-nb/minio、/mc）
- **candidate phase**：Repair 6 / deployment debt
- **review_at**：Repair 6 planning
- **blocker**：NON_BLOCKING（RB-04 CI 全绿；镜像内容 = MinIO 官方镜像）
- **future work**：pin immutable version/digest + 镜像同步/可复现策略

---

## OPS_DEBT_BASE_IMAGE_MUTABLE_TAGS

- **title**：postgres/redis/node/caddy 等 base image 仍使用可变 version tag
- **motivation**：Repair 6（RB-06）只冻结了已登记的 MinIO/mc mutable-image
  debt（§43 边界：不得扩成完整供应链改造）。`postgres:16-alpine`、
  `redis:7-alpine`、`node:24`（Dockerfile ARG NODE_VERSION）、
  `caddy:2-alpine` 仍为 floating version tag，上游 push 同 tag 新 build
  时 CI/生产拉取内容可能变化。这些是官方维护的发行线 tag，风险低于
  `latest`，且 digest pin 会带来更频繁的维护成本。
- **priority**：LOW
- **dependency**：无
- **candidate phase**：Phase 11 / supply-chain hardening batch
- **review_at**：supply-chain hardening planning
- **blocker**：NON_BLOCKING（RB-06 已关闭；MinIO/mc 之外不在 Repair 6 范围）
- **future work**：逐镜像评估 digest pin vs 发行线 tag 的维护成本后统一决策

---

## OPS_DEBT_TEST_SEAM_OPS_RESTORE_SCRIPT

- **title**：rollback.sh 仍保留 OPS_RESTORE_SCRIPT 环境注入 seam（restore 脚本
  executable path 可被 env 覆盖）
- **motivation**：RB-06 FINAL-02 移除了 OPS_RELEASE_VERIFIER（release gate
  权威不可被 env 替换）。OPS_RESTORE_SCRIPT 是更早（--hard 恢复路径）的既有
  测试 seam，影响面为 restore 脚本选择，不属于 release-verifier blocker；
  本轮按冻结边界不顺手重构 hard restore。
- **priority**：LOW
- **dependency**：无
- **candidate phase**：Final Hardening
- **review_at**：Final Hardening planning
- **blocker**：NON_BLOCKING（restore 是人工确认路径，gate 仍在其后 fail closed）
- **future work**：与 OPS_RELEASE_VERIFIER 同模式收敛（测试改走真实 restore
  脚本 + PATH stub），或改为可注入的 TypeScript 函数参数

---

## OPS_DEBT_E2E_7E02_RETRY_FLAKE

- **title**：PR #34 CI e2e job 中 7E-E2E02（report moderation reopen/dueAt）
  单测首跑失败、重试通过（Playwright 计 1 flaky）
- **motivation**：run 36109381086（head e37c7b0）e2e job 整体 success /
  attempt=1，但 phase7e-report-moderation.spec.ts:151（7E-E2E02 reopen
  RESOLVED → IN_REVIEW → dueAt 重置 → case ACTIVE）首 attempt 失败后
  retry 通过（72 passed + 1 flaky）。与本文件 P7-DEBT-E2E-LOAD-01 记录的
  散布 timeout 类症状同类；本轮不做 rerun，按"如实报告"纪律登记。
- **priority**：LOW
- **dependency**：E2E infrastructure
- **candidate phase**：Final Hardening
- **review_at**：Final Hardening planning
- **blocker**：NON_BLOCKING（job 绿；重试通过；与 release identity 变更无关）
- **future work**：隔离复跑定位（timing/goto 超时类）后修复或纳入
  deterministic bootstrap 改造

---

## REPAIR-A-DEBT-PERF-01

- **title**：公开搜索未采用 pg_trgm GIN 索引（评估后不交付；以 query-shape
  复合索引 + createdAt 游走承担检索性能）
- **motivation**：FINAL REPAIR A 评估了 pg_trgm GIN 方案并决定不交付：
  （a）实测陷阱——pg_trgm 对 <3 字符模式无法提取 trigram，GIN 扫描退化为
  全索引条目 + 全表 recheck（2 字词 数码 在 ErrandTask 上 Bitmap Index Scan
  actual rows=60000、Rows Removed by Index Recheck=60000，单查询 50–110ms，
  劣于基线 Seq Scan 的 20–40ms），而 2 字词是中文搜索最常见长度；
  （b）drift 不变量——GIN/partial 索引无法在 Prisma datamodel 表达，交付
  即破坏 D-5/T38-D "migrate diff = empty" 硬门禁。最终交付方案为
  query-shape 复合索引（migration 20260926100802）：检索子查询经
  createdAt 索引游走 + LIMIT 提前终止（EXPLAIN 实证 34–44ms Seq Scan →
  0.1–0.6ms Index Scan），不依赖 GIN。已知边界：零/极低匹配词（如 typo）
  的检索游走无法提前终止，成本与基线 Seq Scan 相当（~40ms 量级）。
  若上线后查询长度分布证明 3+ 字词占比高，可评估"有意识放宽 drift 门禁 +
  全表 GIN"（3 字词 自行车 全表 GIN 时 /search c=25 88.3 rps vs 复合索引
  41.5 rps vs 基线 30.1 rps）或引入中文分词（tsvector/zhparser）/外部
  搜索引擎。
- **priority**：LOW
- **dependency**：真实搜索词长度分布遥测（未建）
- **candidate phase**：FINAL REPAIR B / Phase 8
- **review_at**：Launch Readiness 复审
- **blocker**：NON_BLOCKING——PRODUCTION_BLOCKER = NO；STRUCTURAL_DEBT = YES。
  LR-012 正式分类 = MITIGATED_WITH_DOCUMENTED_BOUNDARY（非 FIXED）：
  B-tree 游走优化依赖 ORDER BY createdAt + LIMIT 12 + 匹配项足够早出现；
  零匹配/极低匹配/typo 查询无法提前终止，仍可能退化到接近基线 Seq Scan
  成本（见 REPAIR-A-DEBT-PERF-02 同类边界与 bench-results/search-boundary
  实测）。通用解（pg_trgm/FTS/中文分词/外部搜索引擎）属 FINAL REPAIR B /
  backlog，本阶段未交付。
---

## REPAIR-A-DEBT-PERF-02

- **title**：/products（及各列表页）count 查询为每次请求的已知 Seq Scan 成本
- **motivation**：`getProductList` 的 `COUNT(*)`（WHERE deletedAt IS NULL +
  NOT EXISTS moderation）在 120k Product 上每次请求 ~20–30ms（campus_perf
  实测）。计数无排序键可依、无法用窄索引显著优化；filters 组合高基数，
  不允许结果缓存。FINAL REPAIR A 通过索引将同请求的 findMany 降至 ~1–2ms，
  count 成为列表页 DB 成本主体。若 launch 后需要进一步优化，方向为
  count 缓存（按精确 filter 组合、短 TTL）或 keyset 分页替代 offset+count。
- **priority**：LOW
- **dependency**：无
- **candidate phase**：Phase 8
- **review_at**：Launch Readiness 复审
- **blocker**：NON_BLOCKING——列表页 p99 已控制在 ~2s @c=100（基线同场景
  无法在 collapse 后测得）
