/**
 * FINAL REPAIR A — EXPLAIN 计划生成与执行（benchmark-only）。
 *
 * 从 bench-results/captured-sql.txt（由 capture-queries.ts 捕获的真实仓储 SQL）
 * 选取代表性查询，按已知调用参数内联 $N 占位符，生成 EXPLAIN (ANALYZE, BUFFERS)
 * 并通过 psql 在 campus_perf 上执行，输出 bench-results/plans-<label>.txt。
 * BEFORE/AFTER 必须使用同一份数据集与同一份捕获 SQL。
 *
 * 用法：
 *   node scripts/bench/make-plans.mjs before
 *   node scripts/bench/make-plans.mjs after
 */
import { readFileSync, writeFileSync } from "node:fs";

const label = process.argv[2] ?? "before";
const lines = readFileSync("bench-results/captured-sql.txt", "utf8").split("\n");

// 环境说明：捕获与替换均使用第 1 页/默认排序/固定关键词，代表公开高频路径。
const KW_HIGH = "%数码%"; // ~20% selectivity
const KW_MED = "%设计%"; // services 标题常用词
const KW_ERRAND = "%代取%";
const NOW = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
const USERS12 = Array.from({ length: 12 }, (_, i) => `buser${String(i).padStart(6, "0")}`);

const STATUS_OPEN = ["OPEN", "CLAIMED", "IN_PROGRESS", "PENDING_CONFIRMATION"];

// 行号（1-based）→ 参数列表（按 $N 内联，N 为 1-based 序号）
const PARAMS = {
  2: ["ACTIVE", 0],
  3: ["OPEN", 0],
  4: ["ACTIVE", 0],
  5: ["ACTIVE", 6, 0],
  6: ["ACTIVE", 6, 0],
  7: ["ACTIVE", 6, 0],
  11: ["OPEN", NOW, 6, 0],
  12: ["OPEN", NOW, 6, 0],
  13: ["ACTIVE", 6, 0],
  14: ["ACTIVE", "VERIFIED", 6, 0],
  15: [0],
  16: [12, 0],
  20: [0],
  21: [12, 0],
  27: ["ACTIVE", KW_HIGH, KW_HIGH, KW_HIGH, KW_HIGH, 12, 0],
  29: ["ACTIVE", KW_MED, KW_MED, KW_MED, 12, 0],
  30: [...STATUS_OPEN, KW_ERRAND, KW_ERRAND, KW_ERRAND, KW_ERRAND, 12, 0],
  31: ["ACTIVE", KW_HIGH, KW_HIGH, KW_HIGH, 12, 0],
  35: [...USERS12, "ACTIVE", 0],
  36: [...USERS12, "ACTIVE", 0],
  37: [...USERS12, "OPEN", 0],
  43: ["AVAILABLE", 0],
  44: ["AVAILABLE", 12, 0],
  50: [0],
  51: [12, 0],
};

const LABELS = {
  2: "homepage.summary.count.services",
  3: "homepage.summary.count.errands",
  4: "homepage.summary.count.products",
  5: "homepage.products.latest",
  6: "homepage.products.popular",
  7: "homepage.products.budget",
  11: "homepage.errands.urgent",
  12: "homepage.errands.highReward",
  13: "homepage.services.top",
  14: "homepage.services.verified",
  15: "products.latest.count",
  16: "products.latest.findMany",
  20: "products.popular.count",
  21: "products.popular.findMany",
  27: "search.users.findMany",
  29: "search.services.findMany",
  30: "search.errands.findMany",
  31: "search.products.findMany",
  35: "search.groupBy.serviceProvider",
  36: "search.groupBy.productSeller",
  37: "search.groupBy.errandPublisher",
  43: "rentals.latest.count",
  44: "rentals.latest.findMany",
  50: "errands.latest.count",
  51: "errands.latest.findMany",
};

function inline(sql, params) {
  return sql.replace(/\$(\d+)/g, (m, n) => {
    const v = params[Number(n) - 1];
    if (v === undefined) throw new Error(`缺参数 $${n}`);
    if (typeof v === "number") return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

const stmts = [];
for (const [lnStr, params] of Object.entries(PARAMS)) {
  const ln = Number(lnStr);
  const raw = lines[ln - 1];
  if (!raw || !raw.trim()) throw new Error(`captured-sql.txt 第 ${ln} 行缺失`);
  const maxN = [...raw.matchAll(/\$(\d+)/g)].reduce((m, x) => Math.max(m, Number(x[1])), 0);
  if (maxN !== params.length) {
    throw new Error(`第 ${ln} 行占位符数 ${maxN} 与参数数 ${params.length} 不一致`);
  }
  stmts.push(`\\echo '===== [${label}] ${LABELS[ln]} (line ${ln}) ====='`);
  stmts.push(`EXPLAIN (ANALYZE, BUFFERS) ${inline(raw, params)};`);
}

writeFileSync(`bench-results/plans-${label}.sql`, stmts.join("\n\n") + "\n");
console.log(`[make-plans] generated bench-results/plans-${label}.sql (${stmts.filter((s) => s.startsWith("EXPLAIN")).length} statements)`);
