/**
 * LR-R3 / STORAGE_OUTAGE_UPLOAD_LONG_TAIL — production rehearsal harness
 * （真实 HTTP POST /api/upload/images，经生产拓扑 Caddy → app → MinIO）。
 *
 * 职责：
 * - 登录（NextAuth credentials，凭据来自 gitignored 的 r3-user.json）
 * - 生成真实可解码 PNG（route 会 sharp 重编码）
 * - 执行 N 次顺序上传 / C 次并发上传，记录每次：
 *   status / elapsed_ms / Retry-After / 响应体 code / assetId
 * - 结果写入 bench-results/resilience/lr-r3-<phase>.json
 *
 * 用法：
 *   node scripts/resilience/storage-latency-harness.mjs --phase healthy
 *   node scripts/resilience/storage-latency-harness.mjs --phase hard-outage
 *   node scripts/resilience/storage-latency-harness.mjs --phase hard-outage --concurrent 10
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import sharp from "sharp";

const ROOT = process.cwd();
const RESULTS_DIR = path.join(ROOT, "bench-results", "resilience");
const BASE = process.env.R3_REHEARSAL_BASE ?? "http://localhost";

function log(message) {
  process.stdout.write(`[lr-r3-harness] ${message}\n`);
}

function argValue(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const PHASE = argValue("--phase") ?? "healthy";
const CONCURRENCY = Number(argValue("--concurrent") ?? 1);
const COUNT = Number(argValue("--count") ?? CONCURRENCY);
const CATEGORY = argValue("--category") ?? "product";

const credentials = JSON.parse(
  fs.readFileSync(path.join(RESULTS_DIR, "r3-user.json"), "utf8"),
);

fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ---------------------------------------------------------------- login

const cookieJar = new Map();

function storeCookies(response) {
  // undici Headers：必须用 getSetCookie()（headers["set-cookie"] 恒为 undefined）
  const raw = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : (response.headers["set-cookie"] ?? []);
  for (const pair of raw) {
    const eq = pair.indexOf("=");
    cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).split(";")[0]);
  }
}

function cookieHeader() {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function login(base) {
  const csrfResponse = await fetch(`${base}/api/auth/csrf`);
  storeCookies(csrfResponse);
  const { csrfToken } = await csrfResponse.json();

  const loginResponse = await fetch(`${base}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookieHeader(),
    },
    body: new URLSearchParams({
      csrfToken,
      email: credentials.email,
      password: credentials.password,
      json: "true",
    }),
    redirect: "manual",
  });
  storeCookies(loginResponse);
  // HTTPS 部署下 NextAuth 会话 cookie 带 __Secure- 前缀；直连 HTTP 无前缀
  const hasSession =
    cookieJar.has("next-auth.session-token") ||
    cookieJar.has("__Secure-next-auth.session-token");
  if (!hasSession) {
    const detail = await loginResponse.text().catch(() => "");
    throw new Error(
      `登录失败（未获得 session cookie）：${loginResponse.status} ${detail.slice(0, 200)}`,
    );
  }
  log("登录成功");
}

// ---------------------------------------------------------------- upload

async function makeValidPng() {
  return sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 90, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

async function uploadOnce(base, png, tag) {
  const form = new FormData();
  form.append(
    "file",
    new File([png], `r3-${tag}.png`, { type: "image/png" }),
  );
  form.append("category", CATEGORY);

  const startedAt = Date.now();
  const response = await fetch(`${base}/api/upload/images`, {
    method: "POST",
    headers: { cookie: cookieHeader() },
    body: form,
  });
  const elapsedMs = Date.now() - startedAt;
  const body = await response.json().catch(() => null);
  return {
    tag,
    status: response.status,
    elapsedMs,
    retryAfter: response.headers.get("retry-after"),
    code: body?.code ?? null,
    assetId: body?.assetId ?? null,
    errorText: body?.error ? String(body.error).slice(0, 80) : null,
  };
}

// ---------------------------------------------------------------- main

await login(BASE);

const png = await makeValidPng();
const tags = Array.from({ length: COUNT }, (_, i) =>
  `${crypto.randomBytes(4).toString("hex")}-${i}`);

log(`phase=${PHASE} 并发=${CONCURRENCY} 总数=${COUNT}`);
const startedAt = Date.now();
const results = [];
if (CONCURRENCY <= 1) {
  for (const tag of tags) {
    results.push(await uploadOnce(BASE, png, tag));
  }
} else {
  results.push(...(await Promise.all(tags.map((tag) => uploadOnce(BASE, png, tag)))));
}
const totalMs = Date.now() - startedAt;

for (const result of results) {
  log(
    `#${result.tag} status=${result.status} elapsed=${result.elapsedMs}ms retryAfter=${result.retryAfter} code=${result.code}`,
  );
}

const summary = {
  phase: PHASE,
  base: BASE,
  concurrency: CONCURRENCY,
  count: COUNT,
  totalMs,
  results,
};
const outPath = path.join(RESULTS_DIR, `lr-r3-${PHASE}.json`);
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
log(`结果已写入 ${outPath}`);
log(JSON.stringify(summary.results.map((r) => ({ status: r.status, ms: r.elapsedMs, retryAfter: r.retryAfter, code: r.code }))));
