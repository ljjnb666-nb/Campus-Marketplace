-- FINAL REPAIR A 审计修复 — campus 过滤敏感性 spot-check（benchmark-only）。
-- 验证 3-campus 数据下，带 campusId 谓词的首页榜单查询是否仍有效使用
-- （无 campusId 前缀的）query-shape 索引，评估 Rows Removed by Filter 成本。
\echo '===== homepage products popular — ALL campuses（基准形态） ====='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY OFF, TIMING OFF)
SELECT "public"."Product"."id" FROM "public"."Product" WHERE ("public"."Product"."deletedAt" IS NULL AND "public"."Product"."status" = CAST('ACTIVE'::text AS "public"."ListingStatus") AND NOT EXISTS(SELECT "t0"."productId" FROM "public"."ListingModeration" AS "t0" WHERE ("t0"."resolvedAt" IS NULL AND ("public"."Product"."id") = ("t0"."productId") AND "t0"."productId" IS NOT NULL))) ORDER BY "public"."Product"."favoriteCount" DESC, "public"."Product"."viewCount" DESC, "public"."Product"."createdAt" DESC LIMIT 6;

\echo '===== homepage products popular — SELECTED campus（bcampus000） ====='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY OFF, TIMING OFF)
SELECT "public"."Product"."id" FROM "public"."Product" WHERE ("public"."Product"."deletedAt" IS NULL AND "public"."Product"."status" = CAST('ACTIVE'::text AS "public"."ListingStatus") AND "public"."Product"."campusId" = 'bcampus000' AND NOT EXISTS(SELECT "t0"."productId" FROM "public"."ListingModeration" AS "t0" WHERE ("t0"."resolvedAt" IS NULL AND ("public"."Product"."id") = ("t0"."productId") AND "t0"."productId" IS NOT NULL))) ORDER BY "public"."Product"."favoriteCount" DESC, "public"."Product"."viewCount" DESC, "public"."Product"."createdAt" DESC LIMIT 6;

\echo '===== homepage services top — ALL campuses ====='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY OFF, TIMING OFF)
SELECT "public"."ServiceListing"."id" FROM "public"."ServiceListing" WHERE ("public"."ServiceListing"."deletedAt" IS NULL AND "public"."ServiceListing"."status" = CAST('ACTIVE'::text AS "public"."ListingStatus") AND NOT EXISTS(SELECT "t0"."serviceListingId" FROM "public"."ListingModeration" AS "t0" WHERE ("t0"."resolvedAt" IS NULL AND ("public"."ServiceListing"."id") = ("t0"."serviceListingId") AND "t0"."serviceListingId" IS NOT NULL))) ORDER BY "public"."ServiceListing"."completedOrderCount" DESC, "public"."ServiceListing"."createdAt" DESC LIMIT 6;

\echo '===== homepage services top — SELECTED campus（bcampus000） ====='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY OFF, TIMING OFF)
SELECT "public"."ServiceListing"."id" FROM "public"."ServiceListing" WHERE ("public"."ServiceListing"."deletedAt" IS NULL AND "public"."ServiceListing"."status" = CAST('ACTIVE'::text AS "public"."ListingStatus") AND "public"."ServiceListing"."campusId" = 'bcampus000' AND NOT EXISTS(SELECT "t0"."serviceListingId" FROM "public"."ListingModeration" AS "t0" WHERE ("t0"."resolvedAt" IS NULL AND ("public"."ServiceListing"."id") = ("t0"."serviceListingId") AND "t0"."serviceListingId" IS NOT NULL))) ORDER BY "public"."ServiceListing"."completedOrderCount" DESC, "public"."ServiceListing"."createdAt" DESC LIMIT 6;

\echo '===== homepage errands urgent — ALL campuses ====='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY OFF, TIMING OFF)
SELECT "public"."ErrandTask"."id" FROM "public"."ErrandTask" WHERE ("public"."ErrandTask"."deletedAt" IS NULL AND "public"."ErrandTask"."status" = CAST('OPEN'::text AS "public"."ErrandTaskStatus") AND "public"."ErrandTask"."deadline" >= '2026-09-26 19:00:00+08' AND NOT EXISTS(SELECT "t0"."errandTaskId" FROM "public"."ListingModeration" AS "t0" WHERE ("t0"."resolvedAt" IS NULL AND ("public"."ErrandTask"."id") = ("t0"."errandTaskId") AND "t0"."errandTaskId" IS NOT NULL))) ORDER BY "public"."ErrandTask"."deadline" ASC, "public"."ErrandTask"."reward" DESC LIMIT 6;

\echo '===== homepage errands urgent — SELECTED campus（bcampus000） ====='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY OFF, TIMING OFF)
SELECT "public"."ErrandTask"."id" FROM "public"."ErrandTask" WHERE ("public"."ErrandTask"."deletedAt" IS NULL AND "public"."ErrandTask"."status" = CAST('OPEN'::text AS "public"."ErrandTaskStatus") AND "public"."ErrandTask"."deadline" >= '2026-09-26 19:00:00+08' AND "public"."ErrandTask"."campusId" = 'bcampus000' AND NOT EXISTS(SELECT "t0"."errandTaskId" FROM "public"."ListingModeration" AS "t0" WHERE ("t0"."resolvedAt" IS NULL AND ("public"."ErrandTask"."id") = ("t0"."errandTaskId") AND "t0"."errandTaskId" IS NOT NULL))) ORDER BY "public"."ErrandTask"."deadline" ASC, "public"."ErrandTask"."reward" DESC LIMIT 6;
