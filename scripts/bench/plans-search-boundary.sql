-- FINAL REPAIR A 审计修复 — search 边界 EXPLAIN 证据（benchmark-only）。
-- COMMON/RARE/ZERO 三类模式在 Product 检索子查询上的实际计划与成本。
\echo '===== COMMON 数码（~20% 匹配，游走早停） ====='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY OFF, TIMING OFF)
SELECT "public"."Product"."id" FROM "public"."Product" WHERE ("public"."Product"."deletedAt" IS NULL AND "public"."Product"."status" = CAST('ACTIVE'::text AS "public"."ListingStatus") AND NOT EXISTS(SELECT "t0"."productId" FROM "public"."ListingModeration" AS "t0" WHERE ("t0"."resolvedAt" IS NULL AND ("public"."Product"."id") = ("t0"."productId") AND "t0"."productId" IS NOT NULL))) AND ("public"."Product"."title" ILIKE '%数码%' OR "public"."Product"."description" ILIKE '%数码%' OR "public"."Product"."locationText" ILIKE '%数码%') ORDER BY "public"."Product"."createdAt" DESC LIMIT 12;

\echo '===== RARE midi键盘（~60 匹配，随机 createdAt 分布） ====='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY OFF, TIMING OFF)
SELECT "public"."Product"."id" FROM "public"."Product" WHERE ("public"."Product"."deletedAt" IS NULL AND "public"."Product"."status" = CAST('ACTIVE'::text AS "public"."ListingStatus") AND NOT EXISTS(SELECT "t0"."productId" FROM "public"."ListingModeration" AS "t0" WHERE ("t0"."resolvedAt" IS NULL AND ("public"."Product"."id") = ("t0"."productId") AND "t0"."productId" IS NOT NULL))) AND ("public"."Product"."title" ILIKE '%midi键盘%' OR "public"."Product"."description" ILIKE '%midi键盘%' OR "public"."Product"."locationText" ILIKE '%midi键盘%') ORDER BY "public"."Product"."createdAt" DESC LIMIT 12;

\echo '===== ZERO 显微镜（0 匹配，游走无法终止） ====='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY OFF, TIMING OFF)
SELECT "public"."Product"."id" FROM "public"."Product" WHERE ("public"."Product"."deletedAt" IS NULL AND "public"."Product"."status" = CAST('ACTIVE'::text AS "public"."ListingStatus") AND NOT EXISTS(SELECT "t0"."productId" FROM "public"."ListingModeration" AS "t0" WHERE ("t0"."resolvedAt" IS NULL AND ("public"."Product"."id") = ("t0"."productId") AND "t0"."productId" IS NOT NULL))) AND ("public"."Product"."title" ILIKE '%显微镜%' OR "public"."Product"."description" ILIKE '%显微镜%' OR "public"."Product"."locationText" ILIKE '%显微镜%') ORDER BY "public"."Product"."createdAt" DESC LIMIT 12;
