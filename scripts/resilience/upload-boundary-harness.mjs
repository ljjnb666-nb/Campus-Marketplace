/**
 * FINAL REPAIR B — LR-001 evidence harness（真实 HTTP multipart 边界矩阵）。
 *
 * 目的：在 production build（next start）上用【真实 multipart/form-data】
 * 复现/验收上传边界行为，杜绝 route.test.ts 的 formData 桩当作 root-cause
 * 证据（桩只能证明 formData 成功之后的逻辑）。
 *
 * 覆盖（A2 矩阵）：
 * - product: 10MiB-1 / 10MiB / 10MiB+1 / 11MiB（undici FormData 真序列化）
 * - avatar:  5MiB-1 / 5MiB / 5MiB+1
 * - outer envelope: 13MiB（> Caddy 12MB request_body max_size）
 * - malformed: 错误 boundary / 非 multipart Content-Type / 缺 file 字段
 * - chunked（无 Content-Length）10MiB+1
 * 每例记录：file payload bytes / 请求 body bytes / Content-Length /
 * direct-next status / proxy status / 响应体摘要。
 *
 * 副作用审计（A8）：矩阵执行前后统计
 * - UploadedAsset 行数（docker exec psql）
 * - MinIO 中该用户前缀下对象数（@aws-sdk/client-s3 ListObjectsV2）
 * - User.storageUsedBytes
 *
 * 用法（仓库根目录）：
 *   node scripts/resilience/upload-boundary-harness.mjs --phase BEFORE
 *   node scripts/resilience/upload-boundary-harness.mjs --phase AFTER
 *   node scripts/resilience/upload-boundary-harness.mjs --phase AFTER --proxy-only
 *
 * 结果写入 bench-results/resilience/lr001-<phase>.json；
 * next start 的 stdout/stderr 写入 bench-results/resilience/lr001-server.log
 * （服务器侧 500/异常证据）。
 */

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";

import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const ROOT = process.cwd();
const RESULTS_DIR = path.join(ROOT, "bench-results", "resilience");
const APP_PORT = 3005;
const PROXY_PORT = 8082;
const BASE = `http://localhost:${APP_PORT}`;
const PROXY = `http://localhost:${PROXY_PORT}`;

const USER_EMAIL = "resilience-harness@campus.local";

/** 登录凭据来自 ensure-resilience-user.ts 写入的本地文件（gitignored，随机轮换）。 */
function loadCredentials() {
  const credentialsPath = path.join(ROOT, "bench-results", "resilience", "harness-user.json");
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(
      "缺少 harness 凭据文件——先运行 npx tsx scripts/resilience/ensure-resilience-user.ts",
    );
  }
  return JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
}
const USER_PASSWORD = loadCredentials().password;

const MIB = 1024 * 1024;

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const PHASE = argValue("--phase") ?? "BEFORE";
const PROXY_ONLY = args.includes("--proxy-only");
const SKIP_SPAWN = args.includes("--no-spawn");

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const serverLogPath = path.join(RESULTS_DIR, `lr001-${PHASE.toLowerCase()}-server.log`);
const serverLog = fs.openSync(serverLogPath, "a");

// ---------------------------------------------------------------- utilities

function log(message) {
  process.stdout.write(`[lr001-harness] ${message}\n`);
}

function randomBytes(size) {
  // 固定种子无关紧要：payload 内容只要不是有效图片即可（A9）
  return crypto.randomBytes(size);
}

/** 原始 HTTP 请求（node:http），完整控制 header/body/chunked。 */
function rawRequest({
  host = "localhost",
  port = APP_PORT,
  method = "POST",
  path: requestPath = "/api/upload/images",
  headers = {},
  body = null,
  writeChunked = null,
  timeoutMs = 30000,
}) {
  return new Promise((resolve) => {
    const request = http.request(
      { host, port, method, path: requestPath, headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("client timeout"));
      resolve({ status: 0, headers: {}, body: "client-timeout" });
    });
    request.on("error", (error) => {
      resolve({ status: 0, headers: {}, body: `request-error: ${error.message}` });
    });

    if (writeChunked) {
      writeChunked(request);
    } else if (body) {
      request.write(body);
    }
    request.end();
  });
}

/** 手工按 multipart/form-data 规范序列化（真实字节，精确控制尺寸）。 */
function buildMultipartBody({ boundary, fields, file }) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.concat([
        Buffer.from(`--${boundary}\r\n`),
        Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`),
        Buffer.from(`${value}\r\n`),
      ]),
    );
  }
  if (file) {
    parts.push(
      Buffer.concat([
        Buffer.from(`--${boundary}\r\n`),
        Buffer.from(
          `Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n`,
        ),
        Buffer.from(`Content-Type: ${file.contentType}\r\n\r\n`),
        file.data,
        Buffer.from(`\r\n`),
      ]),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

// ------------------------------------------------------------- session/auth

const cookieJar = new Map();

function storeCookies(response) {
  // undici Headers：必须用 getSetCookie()（headers["set-cookie"] 恒为 undefined）
  const raw = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : (response.headers["set-cookie"] ?? []);
  for (const entry of raw) {
    const [pair] = entry.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) {
      cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
}

function cookieHeader() {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function login(base) {
  const csrfResponse = await fetch(`${base}/api/auth/csrf`);
  storeCookies(csrfResponse);
  const { csrfToken } = await csrfResponse.json();

  const form = new URLSearchParams({
    csrfToken,
    email: USER_EMAIL,
    password: USER_PASSWORD,
    callbackUrl: `${base}/`,
    json: "true",
  });
  const loginResponse = await fetch(`${base}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookieHeader(),
    },
    body: form.toString(),
    redirect: "manual",
  });
  storeCookies(loginResponse);
  if (!cookieJar.has("next-auth.session-token")) {
    const detail = await loginResponse.text().catch(() => "");
    throw new Error(
      `登录失败（未获得 session cookie）：${loginResponse.status} ${detail.slice(0, 200)}`,
    );
  }
  log(`登录成功（${base}）`);
}

// ------------------------------------------------------- side-effect audits

function psqlCount(sql) {
  const output = execFileSync(
    "docker",
    [
      "exec",
      "campus-marketplace-postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "campus_marketplace",
      "-tAc",
      sql,
    ],
    { encoding: "utf8" },
  ).trim();
  return output;
}

function getHarnessUserId() {
  return psqlCount(
    `SELECT id FROM "User" WHERE email = '${USER_EMAIL}'`,
  );
}

function auditSideEffects() {
  const userId = getHarnessUserId();
  const rows = psqlCount(`SELECT count(*) FROM "UploadedAsset" WHERE "ownerId" = '${userId}'`);
  const quota = psqlCount(`SELECT "storageUsedBytes" FROM "User" WHERE id = '${userId}'`);
  return { userId, assetRows: Number(rows), storageUsedBytes: Number(quota) };
}

const s3 = new S3Client({
  endpoint: process.env.INTEGRATION_S3_ENDPOINT ?? "http://localhost:9100",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.INTEGRATION_S3_ACCESS_KEY_ID ?? "minioadmin",
    secretAccessKey: process.env.INTEGRATION_S3_SECRET_ACCESS_KEY ?? "minioadmin",
  },
});

async function countRemoteObjects(userId) {
  let total = 0;
  for (const bucket of ["campus-public", "campus-private"]) {
    let token;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: userId, ContinuationToken: token }),
      );
      total += page.KeyCount ?? 0;
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
  return total;
}

// ------------------------------------------------------------------- matrix

/** 上传一个用例（undici FormData 真序列化，fetch 自动带 Content-Length）。 */
async function uploadViaFormData({ base, category, payloadBytes, mimeType = "image/jpeg" }) {
  const blob = new Blob([randomBytes(payloadBytes)], { type: mimeType });
  const form = new FormData();
  form.set("file", blob, "photo.jpg");
  form.set("category", category);

  const response = await fetch(`${base}/api/upload/images`, {
    method: "POST",
    headers: { cookie: cookieHeader() },
    body: form,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.slice(0, 200),
    contentType: response.headers.get("content-type"),
    retryAfter: response.headers.get("retry-after"),
  };
}

/** 手工 multipart 上传（精确 Content-Length 控制）。 */
async function uploadViaRawMultipart({ base, category, payloadBytes, mimeType = "image/jpeg" }) {
  const boundary = `----lr001${crypto.randomBytes(8).toString("hex")}`;
  const body = buildMultipartBody({
    boundary,
    fields: { category },
    file: { filename: "photo.jpg", contentType: mimeType, data: randomBytes(payloadBytes) },
  });
  const response = await rawRequest({
    port: new URL(base).port,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.byteLength),
      cookie: cookieHeader(),
    },
    body,
  });
  return {
    status: response.status,
    body: response.body.slice(0, 200),
    requestBytes: body.byteLength,
  };
}

// ------------------------------------------------------------ server spawn

function waitForServer(base, timeoutMs = 60000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const probe = async () => {
      try {
        const response = await fetch(`${base}/api/health`);
        if (response.status > 0) {
          resolve();
          return true;
        }
      } catch {
        // not ready yet
      }
      return false;
    };
    const timer = setInterval(async () => {
      if (await probe()) {
        clearInterval(timer);
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error("server did not become ready in time"));
      }
    }, 500);
  });
}

let serverProcess = null;
let serverLogClosed = false;

/**
 * next start（NODE_ENV=production）会加载 .env.production（合成生产 env，
 * 指向容器主机名 postgres/redis/minio），必须显式覆盖为本机 harness 依赖。
 */
function harnessEnv() {
  return {
    ...process.env,
    NEXTAUTH_URL: BASE,
    NEXTAUTH_SECRET:
      process.env.HARNESS_NEXTAUTH_SECRET ?? "harness-only-secret-not-real-2026",
    DATABASE_URL:
      process.env.HARNESS_DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/campus_marketplace?schema=public",
    REDIS_URL: process.env.HARNESS_REDIS_URL ?? "redis://localhost:6379",
    S3_ENDPOINT: process.env.HARNESS_S3_ENDPOINT ?? "http://localhost:9100",
    // 生产模式 env 断言无条件拒绝 minioadmin 凭据（ALLOW flag 只豁免
    // localhost endpoint）；harness 用非默认凭据。矩阵不含成功上传路径，
    // S3 鉴权不会被触达（全部用例在 size/parse 层终结）。
    S3_ACCESS_KEY_ID: process.env.HARNESS_S3_ACCESS_KEY_ID ?? "harness-local-key",
    S3_SECRET_ACCESS_KEY: process.env.HARNESS_S3_SECRET_ACCESS_KEY ?? "harness-local-secret",
    S3_BUCKET_PUBLIC: "campus-public",
    S3_BUCKET_PRIVATE: "campus-private",
    S3_FORCE_PATH_STYLE: "true",
    PUBLIC_ASSET_BASE_URL: "http://localhost:9100/campus-public",
    ALLOW_LOCAL_S3_IN_PRODUCTION: "true",
    APP_NAME: "校园集市",
    DEFAULT_CAMPUS_SLUG: "main-campus",
  };
}

function killServerProcess() {
  if (!serverProcess) {
    return;
  }
  try {
    if (process.platform === "win32") {
      // Windows：pid 是 cmd 包装进程，必须整树终止，否则 node 孤儿化
      execFileSync("taskkill", ["/pid", String(serverProcess.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      serverProcess.kill("SIGTERM");
    }
  } catch {
    // already gone
  }
}

async function spawnServer() {
  log("启动 next start（production build）:3005 …");
  serverProcess = spawn(
    "npx",
    ["next", "start", "-p", String(APP_PORT)],
    {
      cwd: ROOT,
      env: harnessEnv(),
      stdio: ["ignore", serverLog, serverLog],
      // Windows 上 npx 是 .cmd，Node ≥18.20 必须 shell:true（否则 spawn EINVAL）
      shell: process.platform === "win32",
    },
  );
  serverProcess.on("exit", (code) => {
    if (!serverLogClosed) {
      fs.writeSync(serverLog, `\n[lr001-harness] next start exited code=${code}\n`);
    }
  });
  await waitForServer(BASE);
  log("server ready");
}

// ----------------------------------------------------------------- caddy

async function ensureProxyUp() {
  try {
    const response = await fetch(`${PROXY}/api/health`);
    if (response.status > 0) {
      log(`Caddy proxy 已在 :${PROXY_PORT} 运行`);
      return;
    }
  } catch {
    // need to start
  }
  throw new Error(
    `Caddy proxy 未运行。请先执行 scripts/resilience/start-harness-caddy.sh（:${PROXY_PORT} → :${APP_PORT}）`,
  );
}

// ------------------------------------------------------------------- main

const results = {
  phase: PHASE,
  generatedAt: new Date().toISOString(),
  base: BASE,
  proxy: PROXY,
  cases: [],
};

function pushCase(name, data) {
  results.cases.push({ name, ...data });
}

async function runMatrix(label, base) {
  log(`\n===== 矩阵开始：${label}（${base}）=====`);
  await login(base);

  // 产品类 10MiB 边界
  for (const size of [10 * MIB - 1, 10 * MIB, 10 * MIB + 1, 11 * MIB]) {
    const outcome = await uploadViaFormData({ base, category: "product", payloadBytes: size });
    pushCase(`${label}:product-formdata-${size}B`, {
      filePayloadBytes: size,
      ...outcome,
    });
  }

  // 头像类 5MiB 边界
  for (const size of [5 * MIB - 1, 5 * MIB, 5 * MIB + 1]) {
    const outcome = await uploadViaFormData({ base, category: "avatar", payloadBytes: size });
    pushCase(`${label}:avatar-formdata-${size}B`, { filePayloadBytes: size, ...outcome });
  }

  // outer envelope（> Caddy 12MB）
  const envelope = await uploadViaFormData({ base, category: "product", payloadBytes: 13 * MIB });
  pushCase(`${label}:envelope-13MiB`, { filePayloadBytes: 13 * MIB, ...envelope });

  // 手工 multipart 一例（与 FormData 结果交叉印证）
  const raw10 = await uploadViaRawMultipart({ base, category: "product", payloadBytes: 10 * MIB + 1 });
  pushCase(`${label}:product-rawmultipart-10MiB+1`, { filePayloadBytes: 10 * MIB + 1, ...raw10 });

  // malformed：boundary 不匹配
  {
    const boundary = `----lr001-good${crypto.randomBytes(6).toString("hex")}`;
    const body = buildMultipartBody({
      boundary,
      fields: { category: "product" },
      file: {
        filename: "photo.jpg",
        contentType: "image/jpeg",
        data: randomBytes(1024),
      },
    });
    const response = await rawRequest({
      port: new URL(base).port,
      headers: {
        // 声明的 boundary 与 body 实际使用的不同 → parser 必然失败
        "content-type": `multipart/form-data; boundary=----lr001-mismatched`,
        "content-length": String(body.byteLength),
        cookie: cookieHeader(),
      },
      body,
    });
    pushCase(`${label}:malformed-boundary-mismatch`, { status: response.status, body: response.body.slice(0, 200) });
  }

  // malformed：非 multipart Content-Type
  {
    const response = await rawRequest({
      port: new URL(base).port,
      headers: {
        "content-type": "application/json",
        "content-length": "2",
        cookie: cookieHeader(),
      },
      body: "{}",
    });
    pushCase(`${label}:malformed-not-multipart`, { status: response.status, body: response.body.slice(0, 200) });
  }

  // 缺 file 字段（multipart 合法但无文件）
  {
    const boundary = `----lr001${crypto.randomBytes(8).toString("hex")}`;
    const body = buildMultipartBody({ boundary, fields: { category: "product" }, file: null });
    const response = await rawRequest({
      port: new URL(base).port,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.byteLength),
        cookie: cookieHeader(),
      },
      body,
    });
    pushCase(`${label}:multipart-without-file`, { status: response.status, body: response.body.slice(0, 200) });
  }

  // chunked（无 Content-Length）10MiB+1 product
  {
    const boundary = `----lr001${crypto.randomBytes(8).toString("hex")}`;
    const file = { filename: "photo.jpg", contentType: "image/jpeg", data: randomBytes(10 * MIB + 1) };
    const response = await rawRequest({
      port: new URL(base).port,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "transfer-encoding": "chunked",
        cookie: cookieHeader(),
      },
      writeChunked: (request) => {
        // 分块写出同一份 multipart body
        const head = Buffer.concat([
          Buffer.from(`--${boundary}\r\n`),
          Buffer.from(`Content-Disposition: form-data; name="category"\r\n\r\nproduct\r\n`),
          Buffer.from(`--${boundary}\r\n`),
          Buffer.from(
            `Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n`,
          ),
          Buffer.from(`Content-Type: ${file.contentType}\r\n\r\n`),
        ]);
        request.write(head);
        request.write(file.data);
        request.end(Buffer.from(`\r\n--${boundary}--\r\n`));
      },
    });
    pushCase(`${label}:product-chunked-10MiB+1`, { status: response.status, body: response.body.slice(0, 200) });
  }
}

async function main() {
  if (!SKIP_SPAWN && !PROXY_ONLY) {
    await spawnServer();
  }

  const before = auditSideEffects();
  const objectsBefore = await countRemoteObjects(before.userId);
  log(`副作用基线：rows=${before.assetRows} quota=${before.storageUsedBytes} objects=${objectsBefore}`);
  results.sideEffectsBefore = { ...before, remoteObjects: objectsBefore };

  if (!PROXY_ONLY) {
    await runMatrix("DIRECT_NEXT", BASE);
  }
  if (!SKIP_SPAWN || PROXY_ONLY || args.includes("--with-proxy")) {
    await ensureProxyUp();
    await runMatrix("PRODUCTION_PROXY", PROXY);
  }

  const after = auditSideEffects();
  const objectsAfter = await countRemoteObjects(after.userId);
  log(`副作用终态：rows=${after.assetRows} quota=${after.storageUsedBytes} objects=${objectsAfter}`);
  results.sideEffectsAfter = { ...after, remoteObjects: objectsAfter };
  results.sideEffectDelta = {
    assetRows: after.assetRows - before.assetRows,
    storageUsedBytes: after.storageUsedBytes - before.storageUsedBytes,
    remoteObjects: objectsAfter - objectsBefore,
  };

  const outputPath = path.join(RESULTS_DIR, `lr001-${PHASE.toLowerCase()}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  log(`结果已写入 ${outputPath}`);
}

main()
  .catch((error) => {
    console.error("[lr001-harness] 失败:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    killServerProcess();
    if (!serverLogClosed) {
      serverLogClosed = true;
      fs.closeSync(serverLog);
    }
  });
