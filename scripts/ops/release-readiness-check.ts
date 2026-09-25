/**
 * 发布就绪门禁（RB-06）：deploy.sh 与 rollback.sh 共用的唯一权威 verifier。
 *
 * 契约（docs/PRODUCTION_DEPLOYMENT.md §健康语义与发布门禁）：
 * - /api/health = liveness：只证明进程存活；/api/ready = runtime readiness。
 *   二者是不同概念，本 verifier 两个都必须通过（§冻结：CONTAINER_HEALTH=LIVENESS，
 *   RELEASE_SUCCESS=READINESS）。
 * - 成功 = health 2xx + status ok + release==EXPECTED
 *   且 ready 2xx + release==EXPECTED + status==="ready"
 *   且 dependencies.database/redis/storage 全部 "ok"。
 *   ready 返回 HTTP 200 + degraded 仍然 FAIL（运行时可继续接流量 ≠ 新 release
 *   可被认证为健康；REDIS_READINESS_POLICY 的运行时降级语义不受影响）。
 * - fail closed：任何条件不满足 → exit 1，deploy/rollback 不得宣布 SUCCESS、
 *   不得写 release log。
 * - expected SHA 必须是 40 位 hex Git commit SHA（禁止 unknown/dev/短 SHA/分支名），
 *   在任何网络请求之前校验。
 * - bounded polling：连接拒绝等瞬时错误重试直到 deadline；deadline 后 exit 1。
 *   release 身份不一致等确定性失败同样等到 deadline（caddy 短暂指向旧 upstream
 *   的窗口内，等待是正确行为），deadline 后以最后一次观测的原因报告。
 * - 绝不输出 secrets / dependency 异常细节 / bucket 名称：失败输出只含
 *   reason code、HTTP 状态、release 标识。
 *
 * JSON 一律 JSON.parse + 结构校验（禁止 grep/sed 字符串解析）。
 * 本文件保持零 import：deploy/rollback 服务器环境直接 tsx 执行。
 *
 * 用法：
 *   npx tsx scripts/ops/release-readiness-check.ts \
 *     --base-url "${APP_URL}" --expected-sha "${GIT_SHA}" \
 *     [--timeout-seconds 120] [--poll-interval-seconds 3]
 * 成功 exit 0；任何失败 exit 1。输出单行 machine-readable JSON。
 */

export const RELEASE_SHA_PATTERN = /^[a-fA-F0-9]{40}$/;

/** 失败原因码（§14）：测试必须能稳定区分关键失败 */
export type ReleaseReadinessReason =
  | "INVALID_ARGUMENTS"
  | "INVALID_EXPECTED_SHA"
  | "HEALTH_UNREACHABLE"
  | "HEALTH_INVALID_RESPONSE"
  | "HEALTH_STATUS_NOT_OK"
  | "HEALTH_RELEASE_MISMATCH"
  | "READY_UNREACHABLE"
  | "READY_INVALID_RESPONSE"
  | "READY_RELEASE_MISMATCH"
  | "READY_NOT_READY"
  | "READY_DEGRADED"
  | "DEPENDENCY_DATABASE_NOT_OK"
  | "DEPENDENCY_REDIS_NOT_OK"
  | "DEPENDENCY_STORAGE_NOT_OK"
  | "TIMEOUT";

export interface FetchOutcome {
  /** HTTP 层是否拿到响应（false = 网络层错误，如 connection refused / DNS） */
  responded: boolean;
  /** 是否 2xx（仅 responded 时有意义） */
  ok: boolean;
  /** HTTP 状态码（仅 responded 时有意义） */
  status: number;
  /** 原始响应体（仅 responded 时有意义；绝不进入对外输出） */
  text: string;
}

export interface EvaluationResult {
  ok: boolean;
  reason?: ReleaseReadinessReason;
  /** 观测到的 release 标识（缺失/非法时为 null） */
  release: string | null;
}

export interface VerifyOptions {
  baseUrl: string;
  expectedSha: string;
  /** 总 deadline（秒），必须有上限 */
  timeoutSeconds: number;
  /** 轮询间隔（秒） */
  pollIntervalSeconds?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface VerifyResult {
  ok: boolean;
  /** 首要失败原因（ok=true 时为 null） */
  reason: ReleaseReadinessReason | null;
  /** 全部观测到的失败原因（去重，health 优先于 ready） */
  reasons: ReleaseReadinessReason[];
  healthHttpStatus: number | null;
  readyHttpStatus: number | null;
  /** 最后一次观测的 release（两端一致时） */
  observedRelease: string | null;
  attempts: number;
  durationMs: number;
}

export interface ParsedArgs {
  baseUrl: string;
  expectedSha: string;
  timeoutSeconds: number;
  pollIntervalSeconds: number;
}

const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_POLL_INTERVAL_SECONDS = 3;
const FETCH_TIMEOUT_MS = 5000;

export function isValidExpectedSha(sha: string): boolean {
  return RELEASE_SHA_PATTERN.test(sha);
}

function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

/** 单次 fetch，带独立 per-request 超时；网络层错误归一为 responded=false。
 *  用 AbortController + clearTimeout（而非 AbortSignal.timeout）：
 *  后者的内部 timer 在 process.exit() 时仍挂着，Windows libuv 会断言崩溃
 *  （PASS 也可能以非 0 退出，误导 deploy gate）。 */
async function fetchOutcome(
  url: string,
  fetchImpl: typeof fetch,
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "Cache-Control": "no-store" },
      redirect: "follow",
    });
    const text = await response.text();
    return { responded: true, ok: response.ok, status: response.status, text };
  } catch {
    return { responded: false, ok: false, status: 0, text: "" };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readReleaseField(body: Record<string, unknown>): string | null {
  return typeof body.release === "string" && body.release.length > 0 ? body.release : null;
}

/**
 * health 评估：HTTP 2xx + JSON 可解析 + status==="ok" + release===EXPECTED。
 * health 是 liveness：非 2xx / 不可解析一律 INVALID_RESPONSE（fail closed）。
 */
export function evaluateHealthResponse(
  outcome: FetchOutcome,
  expectedSha: string,
): EvaluationResult {
  if (!outcome.responded) {
    return { ok: false, reason: "HEALTH_UNREACHABLE", release: null };
  }
  const body = parseJson(outcome.text);
  if (!outcome.ok || body === null) {
    return { ok: false, reason: "HEALTH_INVALID_RESPONSE", release: null };
  }
  const release = readReleaseField(body);
  if (body.status !== "ok") {
    return { ok: false, reason: "HEALTH_STATUS_NOT_OK", release };
  }
  if (release === null || normalizeSha(release) !== normalizeSha(expectedSha)) {
    return { ok: false, reason: "HEALTH_RELEASE_MISMATCH", release };
  }
  return { ok: true, release };
}

/**
 * ready 评估：release 一致 + status==="ready" + 三依赖全部 "ok"。
 * 503 + not_ready JSON = 正常契约（§32：503 视为 not ready，绝不吞掉后成功）；
 * 503 + status ready 的自相矛盾响应 = 服务端契约违约，fail closed；
 * HTTP 200 + degraded 仍然 FAIL（READY_DEGRADED）——RB-06 的核心区分：
 * HTTP 2xx 不等于 deployment success。
 */
export function evaluateReadyResponse(
  outcome: FetchOutcome,
  expectedSha: string,
): EvaluationResult {
  if (!outcome.responded) {
    return { ok: false, reason: "READY_UNREACHABLE", release: null };
  }
  const body = parseJson(outcome.text);
  if (body === null) {
    return { ok: false, reason: "READY_INVALID_RESPONSE", release: null };
  }
  const release = readReleaseField(body);
  const dependencies = body.dependencies;
  if (
    release === null ||
    typeof body.status !== "string" ||
    typeof dependencies !== "object" ||
    dependencies === null
  ) {
    return { ok: false, reason: "READY_INVALID_RESPONSE", release };
  }
  if (normalizeSha(release) !== normalizeSha(expectedSha)) {
    return { ok: false, reason: "READY_RELEASE_MISMATCH", release };
  }
  if (body.status === "degraded") {
    return { ok: false, reason: "READY_DEGRADED", release };
  }
  if (body.status === "not_ready") {
    return { ok: false, reason: "READY_NOT_READY", release };
  }
  // status ready 只在 HTTP 2xx 时可信；503+ready 是自相矛盾契约
  if (!outcome.ok || body.status !== "ready") {
    return { ok: false, reason: "READY_INVALID_RESPONSE", release };
  }
  const deps = dependencies as Record<string, unknown>;
  if (deps.database !== "ok") {
    return { ok: false, reason: "DEPENDENCY_DATABASE_NOT_OK", release };
  }
  if (deps.redis !== "ok") {
    return { ok: false, reason: "DEPENDENCY_REDIS_NOT_OK", release };
  }
  if (deps.storage !== "ok") {
    return { ok: false, reason: "DEPENDENCY_STORAGE_NOT_OK", release };
  }
  return { ok: true, release };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

/** 参数解析（与 main 分离以便测试）；非法值抛 Error，不发起任何网络请求 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url" || arg === "--expected-sha" || arg === "--timeout-seconds" || arg === "--poll-interval-seconds") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`missing value for ${arg}`);
      }
      args[arg] = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  const baseUrl = args["--base-url"] ?? "";
  const expectedSha = args["--expected-sha"] ?? "";
  if (!baseUrl) {
    throw new Error("missing required --base-url");
  }
  if (!expectedSha) {
    throw new Error("missing required --expected-sha");
  }
  if (!isValidExpectedSha(expectedSha)) {
    throw new Error("INVALID_EXPECTED_SHA");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error("INVALID_BASE_URL");
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error("INVALID_BASE_URL");
  }
  const timeoutSeconds = parsePositiveInt(
    args["--timeout-seconds"],
    DEFAULT_TIMEOUT_SECONDS,
  );
  const pollIntervalSeconds = parsePositiveInt(
    args["--poll-interval-seconds"],
    DEFAULT_POLL_INTERVAL_SECONDS,
  );
  return { baseUrl, expectedSha, timeoutSeconds, pollIntervalSeconds };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轮询直到全部条件满足或 deadline（bounded，总超时必须有限）。
 * 网络层错误与未满足条件都重试到 deadline（部署启动窗口是瞬时的）；
 * deadline 后以最后一次观测的原因 fail closed。
 */
export async function runReleaseReadinessCheck(options: VerifyOptions): Promise<VerifyResult> {
  const {
    baseUrl,
    expectedSha,
    timeoutSeconds,
    pollIntervalSeconds = DEFAULT_POLL_INTERVAL_SECONDS,
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
  } = options;

  // RELEASE-08：expected SHA 非法 → 在任何网络验证之前 fail closed
  if (!isValidExpectedSha(expectedSha)) {
    return {
      ok: false,
      reason: "INVALID_EXPECTED_SHA",
      reasons: ["INVALID_EXPECTED_SHA"],
      healthHttpStatus: null,
      readyHttpStatus: null,
      observedRelease: null,
      attempts: 0,
      durationMs: 0,
    };
  }

  const startedAt = Date.now();
  const deadline = startedAt + timeoutSeconds * 1000;
  const healthUrl = `${baseUrl.replace(/\/+$/, "")}/api/health`;
  const readyUrl = `${baseUrl.replace(/\/+$/, "")}/api/ready`;

  let attempts = 0;
  let healthHttpStatus: number | null = null;
  let readyHttpStatus: number | null = null;
  let healthEvaluation: EvaluationResult = { ok: false, reason: "HEALTH_UNREACHABLE", release: null };
  let readyEvaluation: EvaluationResult = { ok: false, reason: "READY_UNREACHABLE", release: null };

  for (;;) {
    attempts += 1;
    const [healthOutcome, readyOutcome] = await Promise.all([
      fetchOutcome(healthUrl, fetchImpl),
      fetchOutcome(readyUrl, fetchImpl),
    ]);
    healthEvaluation = evaluateHealthResponse(healthOutcome, expectedSha);
    readyEvaluation = evaluateReadyResponse(readyOutcome, expectedSha);
    if (healthOutcome.responded) {
      healthHttpStatus = healthOutcome.status;
    }
    if (readyOutcome.responded) {
      readyHttpStatus = readyOutcome.status;
    }

    if (healthEvaluation.ok && readyEvaluation.ok) {
      return {
        ok: true,
        reason: null,
        reasons: [],
        healthHttpStatus,
        readyHttpStatus,
        observedRelease: healthEvaluation.release,
        attempts,
        durationMs: Date.now() - startedAt,
      };
    }

    if (Date.now() >= deadline) {
      break;
    }
    await sleepImpl(Math.min(pollIntervalSeconds * 1000, Math.max(deadline - Date.now(), 0)));
  }

  const reasons: ReleaseReadinessReason[] = [];
  if (healthEvaluation.reason) {
    reasons.push(healthEvaluation.reason);
  }
  if (readyEvaluation.reason) {
    reasons.push(readyEvaluation.reason);
  }
  const primary: ReleaseReadinessReason = reasons[0] ?? "TIMEOUT";
  const observedRelease =
    readyEvaluation.release ?? healthEvaluation.release;

  return {
    ok: false,
    reason: primary,
    reasons,
    healthHttpStatus,
    readyHttpStatus,
    observedRelease,
    attempts,
    durationMs: Date.now() - startedAt,
  };
}

function emit(payload: Record<string, unknown>): void {
  console.log(JSON.stringify(payload));
}

/** CLI adapter：只做参数接入与 exit code 映射，逻辑全部在可测函数中 */
async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "INVALID_ARGUMENTS";
    const reason: ReleaseReadinessReason = message === "INVALID_EXPECTED_SHA"
      ? "INVALID_EXPECTED_SHA"
      : "INVALID_ARGUMENTS";
    emit({ result: "FAIL", reason });
    process.exitCode = 1;
    return;
  }

  const result = await runReleaseReadinessCheck(parsed);

  if (result.ok) {
    emit({
      result: "PASS",
      release: result.observedRelease,
      attempts: result.attempts,
      durationMs: result.durationMs,
    });
    process.exitCode = 0;
    return;
  }

  // 绝不输出 secrets / dependency 异常细节 / bucket 名称：
  // 只有 reason code、HTTP 状态与 release 标识（§15）。
  emit({
    result: "FAIL",
    reason: result.reason,
    reasons: result.reasons,
    expected: parsed.expectedSha.toLowerCase(),
    release: result.observedRelease,
    healthHttpStatus: result.healthHttpStatus,
    readyHttpStatus: result.readyHttpStatus,
    attempts: result.attempts,
    durationMs: result.durationMs,
  });
  process.exitCode = 1;
}

// 被 tsx 直接执行时进入 CLI；被测试 import 时不执行
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("release-readiness-check.ts")) {
  main().catch(() => {
    emit({ result: "FAIL", reason: "INVALID_ARGUMENTS" satisfies ReleaseReadinessReason });
    process.exitCode = 1;
  });
}
