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
