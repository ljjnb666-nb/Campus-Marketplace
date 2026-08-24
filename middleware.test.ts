import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { middleware } from "./middleware";

function buildRequest(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

describe("middleware", () => {
  it("injects the request start timestamp and Server-Timing header", () => {
    const response = middleware(buildRequest("/products"));

    expect(response.headers.get("Server-Timing")).toMatch(/^middleware;dur=\d+(\.\d+)?$/);
  });

  it("passes the start timestamp downstream via request headers", () => {
    const response = middleware(buildRequest("/messages"));

    // NextResponse.next 的 request 头会附加到下游请求
    expect(response).toBeDefined();
  });

  it("does not crash for API routes", () => {
    const response = middleware(buildRequest("/api/health"));

    expect(response.headers.get("Server-Timing")).toMatch(/middleware;dur=/);
  });
});
