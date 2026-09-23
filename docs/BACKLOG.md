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
