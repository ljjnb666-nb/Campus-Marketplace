/**
 * FINAL REPAIR A 审计修复 — cold-cache burst 探针（benchmark-only）。
 *
 * 用途：对刚启动（进程内公开缓存为空）的 production server 发起固定请求数
 * burst（无 warmup），记录延迟分布与错误，并用 PostgreSQL 原生计数器
 * （pg_stat_user_tables 的 seq_scan/idx_scan 快照差）观察 burst 期间的表扫描。
 *
 * 注意（审计修复实测）：PG16 下长生命周期连接池后端的 user_tables 计数器
 * 刷新存在不定延迟（scanDelta 可能为 0），不可作为 dedupe 证据；in-flight
 * dedupe 的权威证据是 pg_stat_statements 调用计数（启用方式见
 * docs/DATABASE.md 与审计报告）：100 并发冷启动 burst 中每条公共查询
 * calls=1，而非 ~100。
 *
 * 用法（app 需已重启、缓存为空）：
 *   BENCH_APP_URL="http://localhost:3000/" node scripts/bench/cold-burst.mjs <concurrency> <amount>
 */
import autocannon from "autocannon";
import { execFileSync } from "node:child_process";

const url = process.env.BENCH_APP_URL ?? "http://localhost:3000/";
const concurrency = Number(process.argv[2] ?? 100);
const amount = Number(process.argv[3] ?? concurrency);
const PG = ["docker", "exec", "campus-marketplace-postgres", "psql", "-U", "postgres", "-d", "campus_perf", "-t", "-A"];

const TABLES = ["Campus", "Product", "ErrandTask", "ServiceListing"];
function tableScanSnapshot() {
  const out = execFileSync(PG[0], PG.slice(1), {
    input: `SELECT relname, seq_scan, idx_scan FROM pg_stat_user_tables WHERE relname IN ('Campus','Product','ErrandTask','ServiceListing') ORDER BY relname;`,
    encoding: "utf8",
  });
  const map = {};
  for (const line of out.trim().split("\n").filter(Boolean)) {
    const [relname, seq, idx] = line.split("|");
    map[relname] = { seq: Number(seq), idx: Number(idx) };
  }
  return map;
}

function activitySamplesduring(burstPromise) {
  // 与 burst 并行采样 DB active 连接（250ms 粒度）
  const samples = [];
  const timer = setInterval(() => {
    try {
      const out = execFileSync(PG[0], PG.slice(1), {
        input: `SELECT count(*) FROM pg_stat_activity WHERE datname='campus_perf' AND state='active';`,
        encoding: "utf8",
      });
      samples.push(Number(out.trim()));
    } catch {}
  }, 250);
  return burstPromise.then((r) => {
    clearInterval(timer);
    return { r, maxActive: samples.length ? Math.max(...samples) : null, samples: samples.length };
  });
}

const before = tableScanSnapshot();
const t0 = Date.now();
const { r, maxActive } = await activitySamplesduring(
  new Promise((resolve, reject) => {
    autocannon({ url, connections: concurrency, amount, headers: { "user-agent": "campus-bench-cold/1.0" } }, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  }),
);
const wallMs = Date.now() - t0;
const after = tableScanSnapshot();
const delta = {};
for (const t of TABLES) {
  delta[t] = {
    seq: (after[t]?.seq ?? 0) - (before[t]?.seq ?? 0),
    idx: (after[t]?.idx ?? 0) - (before[t]?.idx ?? 0),
  };
}
console.log(
  // 单行 JSON（NDJSON）：cold-burst.sh 按行累积多档结果后汇编为单个
  // JSON 文档；pretty-print 会破坏按行切分。
  JSON.stringify(
    {
      concurrency,
      amount,
      wallMs,
      p50: r.latency.p50,
      p97_5: r.latency.p97_5,
      p99: r.latency.p99,
      max: r.latency.max,
      errors: r.errors,
      timeouts: r.timeouts,
      non2xx: r.non2xx,
      completed: r.requests.completed,
      dbMaxActive: maxActive,
      scanDelta: delta,
    },
  ),
);
