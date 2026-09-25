// @vitest-environment node
// 本文件含真实 localhost HTTP server 端到端用例（§33），需要 Node fetch；
// jsdom 环境无可用 fetch 实现，其余用例（mock fetch）同样兼容 node 环境。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  evaluateHealthResponse,
  evaluateReadyResponse,
  isValidExpectedSha,
  parseArgs,
  runReleaseReadinessCheck,
} from "../../scripts/ops/release-readiness-check";

/**
 * RB-06：发布就绪门禁 verifier 单元测试（RELEASE-01..08 矩阵）。
 *
 * 核心契约：/api/health 200 ≠ DEPLOY SUCCESS。health 是 liveness，
 * ready 是 runtime readiness；release gate 要求两者同时满足 exact SHA +
 * 严格 ready + 全依赖 ok。ready HTTP 200 + degraded 必须仍然 FAIL
 * （RELEASE-05，RB-06 的关键区分）。
 *
 * 测试通过注入 fetchImpl 模拟网络（无真实公网）；另含一组真实 localhost
 * HTTP server 端到端用例（§33 testability）。
 */

const EXPECTED_SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const WRONG_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function healthBody(release: string = EXPECTED_SHA, status: string = "ok") {
  return { status, release, timestamp: "2026-09-25T00:00:00.000Z" };
}

function readyBody(
  release: string = EXPECTED_SHA,
  status: string = "ready",
  dependencies: Record<string, string> = { database: "ok", redis: "ok", storage: "ok" },
) {
  return { status, release, dependencies };
}

/** 按 URL 路由返回固定响应的 fetch stub */
function fetchFrom(
  routes: Record<string, { status: number; body: string }>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes[url];
    if (!route) {
      return new Response("not found", { status: 404 });
    }
    return new Response(route.body, { status: route.status });
  }) as typeof fetch;
}

function failingFetch(errorBody: string): typeof fetch {
  return (async () => {
    throw new Error(errorBody);
  }) as typeof fetch;
}

function routesFor(
  health: { status: number; body: string },
  ready: { status: number; body: string },
): Record<string, { status: number; body: string }> {
  return {
    "http://app.test/api/health": health,
    "http://app.test/api/ready": ready,
  };
}

async function verify(
  routes: Record<string, { status: number; body: string }>,
  overrides: Partial<Parameters<typeof runReleaseReadinessCheck>[0]> = {},
) {
  return runReleaseReadinessCheck({
    baseUrl: "http://app.test",
    expectedSha: EXPECTED_SHA,
    timeoutSeconds: 1,
    pollIntervalSeconds: 1,
    fetchImpl: fetchFrom(routes),
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("expected SHA 校验（§10）", () => {
  it("接受 40 位大/小写 hex", () => {
    expect(isValidExpectedSha(EXPECTED_SHA)).toBe(true);
    expect(isValidExpectedSha(EXPECTED_SHA.toUpperCase())).toBe(true);
  });

  it("RELEASE-08：invalid expected SHA 在任何网络验证之前 FAIL（fetch 不被调用）", async () => {
    const fetchSpy = vi.fn(failingFetch("ECONNREFUSED must never happen"));
    for (const bad of ["", "dev", "unknown", "abc123", "0f1e2d3c", "master", `${EXPECTED_SHA}x`]) {
      const result = await runReleaseReadinessCheck({
        baseUrl: "http://app.test",
        expectedSha: bad,
        timeoutSeconds: 1,
        fetchImpl: fetchSpy,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("INVALID_EXPECTED_SHA");
      expect(result.attempts).toBe(0);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parseArgs：缺参/非法 SHA/非法 URL → 抛错（exit 1 before network）", () => {
    expect(() => parseArgs(["--expected-sha", EXPECTED_SHA])).toThrow();
    expect(() => parseArgs(["--base-url", "http://app.test"])).toThrow();
    expect(() => parseArgs(["--base-url", "http://app.test", "--expected-sha", "dev"])).toThrow(
      "INVALID_EXPECTED_SHA",
    );
    expect(() => parseArgs(["--base-url", "ftp://app.test", "--expected-sha", EXPECTED_SHA])).toThrow();
    expect(() => parseArgs(["--base-url", "not-a-url", "--expected-sha", EXPECTED_SHA])).toThrow();
    expect(() => parseArgs(["--bogus"])).toThrow();
    expect(
      parseArgs(["--base-url", "http://app.test/", "--expected-sha", EXPECTED_SHA.toUpperCase()]),
    ).toMatchObject({ baseUrl: "http://app.test/", timeoutSeconds: 120, pollIntervalSeconds: 3 });
  });
});

describe("RELEASE 矩阵（§31）", () => {
  it("RELEASE-01：health exact SHA + ready exact SHA + ready + 全依赖 ok → PASS", async () => {
    const result = await verify(
      routesFor(
        { status: 200, body: JSON.stringify(healthBody()) },
        { status: 200, body: JSON.stringify(readyBody()) },
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.reasons).toEqual([]);
    expect(result.observedRelease?.toLowerCase()).toBe(EXPECTED_SHA);
    expect(result.healthHttpStatus).toBe(200);
    expect(result.readyHttpStatus).toBe(200);
  });

  it("RELEASE-02：health wrong SHA → FAIL（HEALTH_RELEASE_MISMATCH）", async () => {
    const result = await verify(
      routesFor(
        { status: 200, body: JSON.stringify(healthBody(WRONG_SHA)) },
        { status: 200, body: JSON.stringify(readyBody()) },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("HEALTH_RELEASE_MISMATCH");
    expect(result.reasons).toContain("HEALTH_RELEASE_MISMATCH");
    expect(result.healthHttpStatus).toBe(200);
  });

  it("RELEASE-03：health expected 但 ready wrong SHA → FAIL（READY_RELEASE_MISMATCH）", async () => {
    const result = await verify(
      routesFor(
        { status: 200, body: JSON.stringify(healthBody()) },
        { status: 200, body: JSON.stringify(readyBody(WRONG_SHA)) },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("READY_RELEASE_MISMATCH");
  });

  it("RELEASE-04：health ok 但 ready not_ready（503）→ FAIL（READY_NOT_READY）", async () => {
    const result = await verify(
      routesFor(
        { status: 200, body: JSON.stringify(healthBody()) },
        { status: 503, body: JSON.stringify(readyBody(EXPECTED_SHA, "not_ready", { database: "failed", redis: "ok", storage: "ok" })) },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("READY_NOT_READY");
    expect(result.readyHttpStatus).toBe(503);
  });

  it("RELEASE-05：health ok + ready degraded（HTTP 200）→ FAIL（READY_DEGRADED）——HTTP 200 不得被误判 deployment success", async () => {
    const result = await verify(
      routesFor(
        { status: 200, body: JSON.stringify(healthBody()) },
        { status: 200, body: JSON.stringify(readyBody(EXPECTED_SHA, "degraded", { database: "ok", redis: "degraded", storage: "ok" })) },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("READY_DEGRADED");
    expect(result.readyHttpStatus).toBe(200);
  });

  it("RELEASE-06：malformed health JSON → FAIL（HEALTH_INVALID_RESPONSE）", async () => {
    const result = await verify(
      routesFor(
        { status: 200, body: "<html>502 Bad Gateway</html>" },
        { status: 200, body: JSON.stringify(readyBody()) },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("HEALTH_INVALID_RESPONSE");
  });

  it("RELEASE-07：malformed ready JSON → FAIL（READY_INVALID_RESPONSE）", async () => {
    const result = await verify(
      routesFor(
        { status: 200, body: JSON.stringify(healthBody()) },
        { status: 200, body: "not-json{" },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("READY_INVALID_RESPONSE");
  });

  it("503 + JSON body status ready（自相矛盾契约）→ FAIL CLOSED（READY_INVALID_RESPONSE）", async () => {
    const result = await verify(
      routesFor(
        { status: 200, body: JSON.stringify(healthBody()) },
        { status: 503, body: JSON.stringify(readyBody()) },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("READY_INVALID_RESPONSE");
  });
});

describe("依赖级失败原因（§14）", () => {
  it.each([
    ["database", "DEPENDENCY_DATABASE_NOT_OK"],
    ["redis", "DEPENDENCY_REDIS_NOT_OK"],
    ["storage", "DEPENDENCY_STORAGE_NOT_OK"],
  ] as const)("status=ready 但 %s ≠ ok → FAIL（%s）", async (dep, expectedReason) => {
    const deps = { database: "ok", redis: "ok", storage: "ok", [dep]: "failed" };
    const result = await verify(
      routesFor(
        { status: 200, body: JSON.stringify(healthBody()) },
        { status: 200, body: JSON.stringify(readyBody(EXPECTED_SHA, "ready", deps)) },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(expectedReason);
  });

  it("health status ≠ ok → FAIL（HEALTH_STATUS_NOT_OK）", async () => {
    const result = await verify(
      routesFor(
        { status: 200, body: JSON.stringify(healthBody(EXPECTED_SHA, "degraded")) },
        { status: 200, body: JSON.stringify(readyBody()) },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("HEALTH_STATUS_NOT_OK");
  });

  it("health 非 2xx（如代理 502）→ FAIL（HEALTH_INVALID_RESPONSE）", async () => {
    const result = await verify(
      routesFor(
        { status: 502, body: "Bad Gateway" },
        { status: 200, body: JSON.stringify(readyBody()) },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("HEALTH_INVALID_RESPONSE");
    expect(result.healthHttpStatus).toBe(502);
  });
});

describe("轮询与超时（§13/§32）", () => {
  it("connection refused：重试直到 deadline，TIMEOUT 后 fail closed（HEALTH_UNREACHABLE）", async () => {
    const result = await runReleaseReadinessCheck({
      baseUrl: "http://app.test",
      expectedSha: EXPECTED_SHA,
      timeoutSeconds: 1,
      pollIntervalSeconds: 1,
      fetchImpl: failingFetch("connect ECONNREFUSED 127.0.0.1:3000"),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("HEALTH_UNREACHABLE");
    expect(result.reasons).toContain("READY_UNREACHABLE");
    expect(result.attempts).toBeGreaterThanOrEqual(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(900);
  });

  it("瞬时故障恢复：前 N 次 refused、随后全绿 → PASS", async () => {
    let call = 0;
    const flakyFetch = (async (input: RequestInfo | URL) => {
      call += 1;
      if (call <= 4) {
        throw new Error("ECONNREFUSED during boot");
      }
      const url = String(input);
      if (url.endsWith("/api/ready")) {
        return new Response(JSON.stringify(readyBody()), { status: 200 });
      }
      return new Response(JSON.stringify(healthBody()), { status: 200 });
    }) as typeof fetch;

    const result = await runReleaseReadinessCheck({
      baseUrl: "http://app.test",
      expectedSha: EXPECTED_SHA,
      timeoutSeconds: 5,
      pollIntervalSeconds: 1,
      fetchImpl: flakyFetch,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it("总超时必须有上限：deadline 后立刻返回，不无限轮询", async () => {
    const sleepSpy = vi.fn((ms: number): Promise<void> => {
      void ms;
      return Promise.resolve();
    });
    const result = await runReleaseReadinessCheck({
      baseUrl: "http://app.test",
      expectedSha: EXPECTED_SHA,
      timeoutSeconds: 1,
      pollIntervalSeconds: 30,
      fetchImpl: fetchFrom(routesFor({ status: 200, body: JSON.stringify(healthBody(WRONG_SHA)) }, { status: 200, body: JSON.stringify(readyBody(WRONG_SHA)) })),
      sleepImpl: sleepSpy,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("HEALTH_RELEASE_MISMATCH");
    // sleep 被夹在剩余预算内，deadline 到达后不再继续 sleep 轮询
    expect(sleepSpy.mock.calls.every(([ms]) => ms <= 30_000)).toBe(true);
  });
});

describe("NO SECRET OUTPUT（§15）", () => {
  it("失败结果绝不包含网络错误细节/URL/凭据", async () => {
    const secretShape = "postgresql://app:sup3rs3cret@db.internal:5432/campus";
    const result = await runReleaseReadinessCheck({
      baseUrl: "http://app.test",
      expectedSha: EXPECTED_SHA,
      timeoutSeconds: 1,
      pollIntervalSeconds: 1,
      fetchImpl: failingFetch(`connect ECONNREFUSED ${secretShape}`),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sup3rs3cret");
    expect(serialized).not.toContain("ECONNREFUSED");
    expect(serialized).not.toContain("db.internal");
  });
});

describe("真实 localhost HTTP server 端到端（§33）", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          }),
      ),
    );
  });

  function startServer(
    health: { code: number; payload: string },
    ready: { code: number; payload: string },
  ): Promise<string> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const route = req.url?.endsWith("/api/ready") ? ready : health;
        res.writeHead(route.code, { "content-type": "application/json" });
        res.end(route.payload);
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => {
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });
  }

  it("真实栈：全绿 → PASS；degraded 200 → READY_DEGRADED FAIL（RB-06 关键区分）", async () => {
    const okBase = await startServer(
      { code: 200, payload: JSON.stringify(healthBody()) },
      { code: 200, payload: JSON.stringify(readyBody()) },
    );
    const okResult = await runReleaseReadinessCheck({
      baseUrl: okBase,
      expectedSha: EXPECTED_SHA,
      timeoutSeconds: 3,
      pollIntervalSeconds: 1,
    });
    expect(okResult.ok).toBe(true);

    const degradedBase = await startServer(
      { code: 200, payload: JSON.stringify(healthBody()) },
      { code: 200, payload: JSON.stringify(readyBody(EXPECTED_SHA, "degraded", { database: "ok", redis: "degraded", storage: "ok" })) },
    );
    const degradedResult = await runReleaseReadinessCheck({
      baseUrl: degradedBase,
      expectedSha: EXPECTED_SHA,
      timeoutSeconds: 1,
      pollIntervalSeconds: 1,
    });
    expect(degradedResult.ok).toBe(false);
    expect(degradedResult.reason).toBe("READY_DEGRADED");
  }, 20_000);

  it("真实栈：connection refused（无监听端口）→ 重试到 deadline 后 fail closed", async () => {
    // 借用一个确定未被监听的端口：先占住再释放
    const probe = http.createServer();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, "127.0.0.1", () => resolve((probe.address() as AddressInfo).port));
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const result = await runReleaseReadinessCheck({
      baseUrl: `http://127.0.0.1:${port}`,
      expectedSha: EXPECTED_SHA,
      timeoutSeconds: 1,
      pollIntervalSeconds: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("HEALTH_UNREACHABLE");
  }, 20_000);
});

describe("纯函数评估器边界", () => {
  it("release 字段大小写不敏感匹配", () => {
    const outcome = { responded: true, ok: true, status: 200, text: JSON.stringify(healthBody(EXPECTED_SHA.toUpperCase())) };
    expect(evaluateHealthResponse(outcome, EXPECTED_SHA).ok).toBe(true);
  });

  it("release 字段缺失/非字符串 → mismatch / invalid", () => {
    const noRelease = { responded: true, ok: true, status: 200, text: JSON.stringify({ status: "ok" }) };
    expect(evaluateHealthResponse(noRelease, EXPECTED_SHA).reason).toBe("HEALTH_RELEASE_MISMATCH");
    const arrayBody = { responded: true, ok: true, status: 200, text: "[1,2,3]" };
    expect(evaluateHealthResponse(arrayBody, EXPECTED_SHA).reason).toBe("HEALTH_INVALID_RESPONSE");
  });

  it("ready dependencies 缺失 → READY_INVALID_RESPONSE", () => {
    const outcome = { responded: true, ok: true, status: 200, text: JSON.stringify({ status: "ready", release: EXPECTED_SHA }) };
    expect(evaluateReadyResponse(outcome, EXPECTED_SHA).reason).toBe("READY_INVALID_RESPONSE");
  });

  it("网络层错误 → *_UNREACHABLE", () => {
    const outcome = { responded: false, ok: false, status: 0, text: "" };
    expect(evaluateHealthResponse(outcome, EXPECTED_SHA).reason).toBe("HEALTH_UNREACHABLE");
    expect(evaluateReadyResponse(outcome, EXPECTED_SHA).reason).toBe("READY_UNREACHABLE");
  });
});

afterAll(() => {
  // fetch/Response 均为 Node 内建，无全局状态需要清理
});
