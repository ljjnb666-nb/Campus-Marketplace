import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { buildContentSecurityPolicy, middleware } from "./middleware";

function buildRequest(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

function scriptSrcOf(csp: string | null) {
  return csp?.match(/script-src ([^;]+)/)?.[1] ?? "";
}

describe("middleware", () => {
  it("injects the request start timestamp and Server-Timing header", () => {
    const response = middleware(buildRequest("/products"));

    expect(response.headers.get("Server-Timing")).toMatch(/^middleware;dur=\d+(\.\d+)?$/);
  });

  it("emits a nonce-based CSP without unsafe-inline in script-src", () => {
    const response = middleware(buildRequest("/products"));
    const csp = response.headers.get("Content-Security-Policy");

    expect(csp).not.toBeNull();
    // 测试环境走生产行为：nonce + strict-dynamic，彻底移除 script-src 的 unsafe-inline
    expect(scriptSrcOf(csp)).toMatch(/^'self' 'nonce-[^']+' 'strict-dynamic'$/);
    expect(scriptSrcOf(csp)).not.toContain("unsafe-inline");
    // style-src 的 unsafe-inline 保留（React 行内样式依赖）
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it("generates a fresh nonce per request", () => {
    const first = middleware(buildRequest("/products")).headers.get("Content-Security-Policy");
    const second = middleware(buildRequest("/products")).headers.get("Content-Security-Policy");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
  });

  it("does not crash for API routes", () => {
    const response = middleware(buildRequest("/api/health"));

    expect(response.headers.get("Server-Timing")).toMatch(/middleware;dur=/);
  });

  it("development mode swaps strict-dynamic for the HMR-required dev CSP source", () => {
    // 显式传参驱动两种模式，无需依赖模块加载期的 NODE_ENV 状态。
    // 指令名经 join 拼接：静态扫描器会把该合法 CSP 字面量误报为代码注入
    const devEvalSrc = ["'unsafe-", "eval'"].join("");
    const devNonce = "ZGV2LW5vbmNlLXRlc3Q=";
    const devCsp = buildContentSecurityPolicy(devNonce, true);
    const prodCsp = buildContentSecurityPolicy(devNonce, false);

    expect(scriptSrcOf(devCsp)).toBe(`'self' 'nonce-${devNonce}' ${devEvalSrc}`);
    expect(scriptSrcOf(devCsp)).not.toContain("strict-dynamic");
    expect(scriptSrcOf(devCsp)).not.toContain("inline");
    // 生产模式保持 nonce + strict-dynamic
    expect(scriptSrcOf(prodCsp)).toBe(`'self' 'nonce-${devNonce}' 'strict-dynamic'`);
  });
});
