import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const { pingDatabaseMock } = vi.hoisted(() => ({
  pingDatabaseMock: vi.fn(),
}));

vi.mock("@/repositories/health-repository", () => ({
  pingDatabase: pingDatabaseMock,
}));

import { GET } from "@/app/api/health/route";

// 路由签名要求 Request（读取请求头做 request-id 关联）；测试统一用最小请求
const dummyRequest = () => new Request("http://localhost/api/health");

/**
 * BLOCKER 2：/api/health = 真 liveness（进程存活 + release identity）。
 * HEALTH_DB_INDEPENDENCE_TEST：health 绝不访问 PostgreSQL——DB 停机时
 * 仍必须 200；依赖故障的语义全部在 /api/ready。
 */
describe("GET /api/health (liveness)", () => {
  beforeEach(() => {
    pingDatabaseMock.mockReset();
  });

  it("HEALTH_DB_INDEPENDENCE_TEST：DB 正常时 200，且根本不调用 pingDatabase", async () => {
    pingDatabaseMock.mockResolvedValue(undefined);

    const response = await GET(dummyRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("string");
    // 真 liveness：无 DB 访问（副作用为零）
    expect(pingDatabaseMock).not.toHaveBeenCalled();
  });

  it("DB 故障/停机时仍 200（health 与依赖状态解耦）", async () => {
    pingDatabaseMock.mockRejectedValue(new Error("connection refused"));

    const response = await GET(dummyRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(pingDatabaseMock).not.toHaveBeenCalled();
  });

  it("reports release identity from RELEASE_SHA, falling back to dev", async () => {
    const previous = process.env.RELEASE_SHA;
    try {
      delete process.env.RELEASE_SHA;
      expect((await (await GET(dummyRequest())).json()).release).toBe("dev");

      process.env.RELEASE_SHA = "abc123";
      expect((await (await GET(dummyRequest())).json()).release).toBe("abc123");
    } finally {
      if (previous === undefined) delete process.env.RELEASE_SHA;
      else process.env.RELEASE_SHA = previous;
    }
  });

  it("is a dynamic route response (NextResponse instance) and leaks no secrets", async () => {
    const response = await GET(dummyRequest());
    const raw = JSON.stringify(await response.json());

    expect(response).toBeInstanceOf(NextResponse);
    expect(raw).not.toMatch(/postgres(ql)?:\/\//);
    expect(raw).not.toMatch(/redis:\/\//);
    expect(raw).not.toContain("secret");
  });
});
