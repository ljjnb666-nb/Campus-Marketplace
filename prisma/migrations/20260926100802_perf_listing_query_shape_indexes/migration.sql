-- FINAL REPAIR A（LR-012/LR-013）：公开列表/搜索路径 query-shape 索引。
-- 全部由 prisma/schema.prisma 的 @@index 表达（datamodel 可表达，保持
-- D-5/T38-D "migrations vs datamodel drift = NONE" 不变量；GIN trigram /
-- partial index 无法在 datamodel 中表达，评估结论见 BACKLOG
-- REPAIR-A-DEBT-PERF-01）。
--
-- 证据基线（campus_perf 造数集：Product 120k / ErrandTask 60k /
-- ServiceListing 40k / RentalListing 20k / User 5k，见
-- scripts/bench/seed-perf.mjs）：修复前首页榜单与列表默认序全部为
-- Parallel Seq Scan / Seq Scan + top-N heapsort：
--   首页商品三榜 each ~27–28ms；首页跑腿两榜 ~19.4–19.7ms；
--   首页服务两榜 ~11.3–12.9ms；/products findMany ~26.9ms + count ~20.1ms；
--   /search 四个子查询 34–44ms（数码/自行车/代取/设计词）。
-- 修复后同形状查询走 Index Scan 流式 LIMIT 提前终止（bench-results/
-- plans-after.txt）：榜单/列表 findMany 0.06–2.1ms；搜索子查询 0.1–0.6ms。
--
-- 形状 → 索引（btree 反向扫描覆盖 DESC；混合方向逐列显式标注）：
--   Product  (status, createdAt DESC)                首页 latest + status 过滤列表
--   Product  (createdAt DESC)                        /products ALL 默认序 + 检索游走
--   Product  (favoriteCount DESC, viewCount DESC, createdAt DESC)
--                                                    首页 popular + /products popular
--   Product  (price, favoriteCount DESC, createdAt DESC)
--                                                    首页 budget + /products price_asc
--   Product  (price DESC, favoriteCount DESC, createdAt DESC)
--                                                    /products price_desc
--   ErrandTask (status, deadline, reward DESC)       首页 urgent（deadline>=now 范围内流式）
--   ErrandTask (status, reward DESC, deadline)       首页 highReward
--   ErrandTask (createdAt DESC)                      /errands 默认序 + 检索游走
--   ServiceListing (completedOrderCount DESC, createdAt DESC)
--                                                    首页 top/verified + orders_desc
--   ServiceListing (createdAt DESC)                  /services 默认序 + 检索游走
--   RentalListing (createdAt DESC)                   /rentals 默认序
--   RentalListing (favoriteCount DESC, createdAt DESC) /rentals popular
--
-- 说明：
-- - status 作为索引列而非 partial 谓词：Prisma 将枚举等值写成
--   CAST($n::text AS enum)，计划期无法证明其与 partial 谓词的蕴含
--   （已用 EXPLAIN 复现回退）；作等值前缀列时 btree 仍保证后续列的
--   流式序。
-- - 软删谓词 deletedAt IS NULL 不作 partial 条件：查询侧恒为字面量，
--   非 partial 索引仅多 ~2% recheck，换取 datamodel 可表达。
-- - 语义不变：索引不改变任何查询的结果集；写入放大限于上述 12 个
--   B-tree（列窄、无部分谓词），均在公开高频读路径上核算过收益。

-- CreateIndex
CREATE INDEX "ErrandTask_status_deadline_reward_idx" ON "ErrandTask"("status", "deadline", "reward" DESC);

-- CreateIndex
CREATE INDEX "ErrandTask_status_reward_deadline_idx" ON "ErrandTask"("status", "reward" DESC, "deadline");

-- CreateIndex
CREATE INDEX "ErrandTask_createdAt_idx" ON "ErrandTask"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "Product_status_createdAt_idx" ON "Product"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Product_createdAt_idx" ON "Product"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "Product_favoriteCount_viewCount_createdAt_idx" ON "Product"("favoriteCount" DESC, "viewCount" DESC, "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Product_budget_idx" ON "Product"("price", "favoriteCount" DESC, "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Product_price_desc_idx" ON "Product"("price" DESC, "favoriteCount" DESC, "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RentalListing_createdAt_idx" ON "RentalListing"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "RentalListing_favoriteCount_createdAt_idx" ON "RentalListing"("favoriteCount" DESC, "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ServiceListing_completedOrderCount_createdAt_idx" ON "ServiceListing"("completedOrderCount" DESC, "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ServiceListing_createdAt_idx" ON "ServiceListing"("createdAt" DESC);
