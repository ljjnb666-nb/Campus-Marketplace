/**
 * FINAL REPAIR A — production load-test harness（benchmark-only）。
 *
 * 复现方式（必须对 production build 运行）：
 *   1. npm run build && npm start（DATABASE_URL 指向 campus_perf 造数库）
 *   2. BENCH_APP_PID=<server pid> node scripts/bench/load-test.mjs
 *      可用环境变量（全部可选，见下方默认值）：
 *        BENCH_BASE_URL    默认 http://localhost:3000
 *        BENCH_ROUTES      默认 "/,/products,/search?q=%E6%95%B0%E7%A0%81"
 *        BENCH_CONCURRENCIES 默认 "1,5,10,25,50"
 *        BENCH_DURATION    默认 20（秒/档）
 *        BENCH_WARMUP      默认 5（秒，不计入结果）
 *        BENCH_LABEL       默认 run
 *        BENCH_OUT         JSON 输出路径
 *        BENCH_PG_CONTAINER/BENCH_PG_DB/BENCH_PG_USER  DB 采样
 *        BENCH_APP_PID     server 进程（用于 CPU/RSS 采样）
 *
 * 记录项：rps、p50/p90/p95(派生)/p97.5/p99（p95 由 HDR 直方图 p90 与 p97.5
 * 对数线性插值派生，p97.5 与 p99 为原始值）、errors、timeouts、non2xx、
 * DB 活跃/总连接采样（pg_stat_activity，1s 粒度）、app 进程 CPU%/RSS。
 */
import autocannon from "autocannon";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const BASE_URL = process.env.BENCH_BASE_URL ?? "http://localhost:3000";
const OUT = process.env.BENCH_OUT ?? null;
const LABEL = process.env.BENCH_LABEL ?? "run";
const DURATION = Number(process.env.BENCH_DURATION ?? 20);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 5);
const ROUTES = (process.env.BENCH_ROUTES ?? "/,/products,/search?q=%E6%95%B0%E7%A0%81")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);
const CONCURRENCIES = (process.env.BENCH_CONCURRENCIES ?? "1,5,10,25,50")
  .split(",")
  .map(Number)
  .filter(Boolean);

const PG_CONTAINER = process.env.BENCH_PG_CONTAINER ?? "campus-marketplace-postgres";
const PG_DB = process.env.BENCH_PG_DB ?? "campus_perf";
const PG_USER = process.env.BENCH_PG_USER ?? "postgres";

function sampleDb() {
  const sql =
    "SELECT count(*) FILTER (WHERE state='active') AS active, " +
    "count(*) FILTER (WHERE state='idle in transaction') AS idle_tx, " +
    "count(*) AS total FROM pg_stat_activity WHERE datname=current_database()";
  const r = spawnSync(
    "docker",
    ["exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-t", "-A", "-F", "|", "-c", sql],
    { encoding: "utf8", timeout: 5000 },
  );
  if (r.status !== 0) return null;
  const [active, idle_tx, total] = r.stdout.trim().split("|").map(Number);
  return { active, idle_tx, total };
}

function sampleAppProcess() {
  const pid = process.env.BENCH_APP_PID;
  if (!pid) return null;
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command",
      `Get-Process -Id ${pid} | ForEach-Object { \"$([double]$_.CPU)|$($_.WorkingSet64)\" }`],
    { encoding: "utf8", timeout: 5000 },
  );
  if (r.status !== 0 || !r.stdout.trim()) return null;
  const [cpuSec, rss] = r.stdout.trim().split("|").map(Number);
  return { cpuSec, rssBytes: rss };
}

// p95 派生：HDR 固定分位不含 95；在相邻原始分位 (p90, p97.5) 间对数线性插值。
function deriveP95(p90, p975) {
  if (!p90 || !p975) return null;
  const a = Math.log(Math.max(p90, 1));
  const b = Math.log(Math.max(p975, 1));
  const t = (0.95 - 0.90) / (0.975 - 0.90);
  return Math.round(Math.exp(a + t * (b - a)) * 10) / 10;
}

async function runOnce(url, connections, duration) {
  return new Promise((resolve, reject) => {
    const dbSamples = [];
    const procSamples = [];
    let lastCpu = null;
    const timer = setInterval(() => {
      const db = sampleDb();
      if (db) dbSamples.push(db);
      const proc = sampleAppProcess();
      if (proc) {
        if (lastCpu !== null && proc.cpuSec >= lastCpu.cpuSec) {
          procSamples.push({ cpuPercent: proc.cpuSec - lastCpu.cpuSec, rssBytes: proc.rssBytes });
        }
        lastCpu = proc;
      }
    }, 1000);
    autocannon(
      { url, connections, duration, headers: { "user-agent": "campus-bench/1.0" } },
      (err, result) => {
        clearInterval(timer);
        if (err) return reject(err);
        const avgActiveDb = dbSamples.length
          ? dbSamples.reduce((s, x) => s + x.active, 0) / dbSamples.length
          : null;
        const maxTotalDb = dbSamples.length ? Math.max(...dbSamples.map((x) => x.total)) : null;
        const avgCpu = procSamples.length
          ? procSamples.reduce((s, x) => s + x.cpuPercent, 0) / procSamples.length
          : null;
        const maxRss = procSamples.length ? Math.max(...procSamples.map((x) => x.rssBytes)) : null;
        resolve({
          requests: result.requests.total,
          rps: result.requests.average,
          p50: result.latency.p50,
          p90: result.latency.p90,
          p95Derived: deriveP95(result.latency.p90, result.latency.p97_5),
          p97_5: result.latency.p97_5,
          p99: result.latency.p99,
          max: result.latency.max,
          errors: result.errors,
          timeouts: result.timeouts,
          non2xx: result.non2xx,
          dbSamplesCount: dbSamples.length,
          dbAvgActive: avgActiveDb,
          dbMaxTotal: maxTotalDb,
          appAvgCpuPercent: avgCpu,
          appMaxRssBytes: maxRss,
        });
      },
    );
  });
}

const results = [];
console.log(`[load-test] base=${BASE_URL} routes=${ROUTES.length} conc=${CONCURRENCIES.join(",")} dur=${DURATION}s label=${LABEL}`);
for (const route of ROUTES) {
  const url = `${BASE_URL}${route}`;
  if (WARMUP > 0) {
    process.stdout.write(`[load-test] warmup ${route} (${WARMUP}s)... done\n`);
    await runOnce(url, 5, WARMUP);
  }
  for (const c of CONCURRENCIES) {
    const t0 = Date.now();
    const r = await runOnce(url, c, DURATION);
    console.log(
      `[load-test] ${route} c=${String(c).padStart(3)} | rps=${r.rps.toFixed(1).padStart(8)} p50=${String(r.p50).padStart(5)}ms p95*=${String(r.p95Derived).padStart(6)}ms p99=${String(r.p99).padStart(7)}ms err=${r.errors} timeout=${r.timeouts} non2xx=${r.non2xx} dbActive≈${r.dbAvgActive?.toFixed(1) ?? "?"} dbTotalMax=${r.dbMaxTotal ?? "?"} cpu≈${r.appAvgCpuPercent?.toFixed(0) ?? "?"}%`,
    );
    results.push({ label: LABEL, route, concurrency: c, durationSec: DURATION, ...r, wallMs: Date.now() - t0 });
  }
}

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ baseUrl: BASE_URL, label: LABEL, durationSec: DURATION, routes: ROUTES, results }, null, 2));
  console.log(`[load-test] written ${OUT}`);
}
