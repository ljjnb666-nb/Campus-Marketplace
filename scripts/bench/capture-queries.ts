/**
 * FINAL REPAIR A — 捕获公开页面真实 SQL（benchmark-only）。
 *
 * 以 NODE_ENV=development 运行（@/lib/prisma 在该模式打印 prisma:query 行），
 * 触发公开页面使用的仓储函数，把真实发出的 SQL 记到 stdout：
 *   NODE_ENV=development DATABASE_URL=... npx tsx scripts/bench/capture-queries.ts \
 *     > bench-results/capture-raw.log 2>&1
 * 捕获到的 SQL 用于核对 EXPLAIN (ANALYZE, BUFFERS) 的 query shape
 * （BEFORE/AFTER 必须逐字节同形）。
 */
async function main() {
  const { getHomepageSummary, getHomepageProducts, getHomepageErrands, getHomepageServices } =
    await import("../../src/repositories/home-repository");
  const { getProductList, getProductFormMeta } = await import("../../src/repositories/product-repository");
  const { getSearchResults } = await import("../../src/repositories/search-repository");
  const { getServiceList } = await import("../../src/repositories/service-repository");
  const { getRentalListings } = await import("../../src/repositories/rental-listing-repository");
  const { getErrandList } = await import("../../src/repositories/errand-repository");

  await getHomepageSummary({});
  await getHomepageProducts({});
  await getHomepageErrands({});
  await getHomepageServices({});
  await getProductList({ sort: "latest", page: 1 });
  await getProductList({ sort: "popular", page: 1 });
  await getProductFormMeta();
  await getSearchResults("数码");
  await getServiceList({ sort: "latest", page: 1 });
  await getRentalListings({ sort: "latest", page: 1 });
  await getErrandList({ sort: "latest", page: 1 });

  console.log("CAPTURE_DONE");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
