import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RB-03 REVIEW FIX：POST /api/legal/acceptances HTTP adapter 合同。
 *
 * 权威写 = recordReconsentAcceptances（与 Server Action 共用同一服务）。
 * lifecycle 失效合同（§11 冻结）：
 * - entry inactive → 401 { error: "未登录或账号不可用", code: "ACCOUNT_INACTIVE" }
 * - race-lost（entry ACTIVE 但守卫 AUTH_ACCOUNT_INACTIVE）→ 同形 401
 *   ACCOUNT_INACTIVE —— 禁止因 race timing 暴露不同 machine code/status。
 * 成功 body { created, skipped, compliant } 与 private,no-store 保持不变。
 */

const {
  getVerifiedSession,
  recordReconsentAcceptances,
  getUserAcceptanceStatus,
  listUserAcceptances,
  isRateLimited,
} = vi.hoisted(() => ({
  getVerifiedSession: vi.fn(),
  recordReconsentAcceptances: vi.fn(),
  getUserAcceptanceStatus: vi.fn(),
  listUserAcceptances: vi.fn(),
  isRateLimited: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  getVerifiedSession,
  VERIFIED_SESSION_HTTP_STATUS: {
    UNAUTHENTICATED: 401,
    ACCOUNT_INACTIVE: 401,
    LEGAL_ACCEPTANCE_REQUIRED: 403,
  },
}));

vi.mock("@/lib/legal/policy-service", () => ({
  getUserAcceptanceStatus,
  listUserAcceptances,
  recordReconsentAcceptances,
}));

vi.mock("@/lib/rate-limit", () => ({
  isRateLimited,
}));

import { POST, GET } from "@/app/api/legal/acceptances/route";

function buildRequest(body: unknown) {
  return new NextRequest("http://localhost:3000/api/legal/acceptances", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function callPost(body: unknown) {
  return POST(buildRequest(body));
}

beforeEach(() => {
  getVerifiedSession
    .mockReset()
    .mockResolvedValue({ ok: true, user: { id: "user-1", email: "u@x", name: "n", role: "STUDENT" } });
  isRateLimited.mockReset().mockResolvedValue({ limited: false });
  recordReconsentAcceptances.mockReset().mockResolvedValue({ created: 2, skipped: 0 });
  getUserAcceptanceStatus
    .mockReset()
    .mockResolvedValue({ compliant: true, required: [], pending: [] });
  listUserAcceptances.mockReset().mockResolvedValue([]);
});

describe("POST /api/legal/acceptances（RB-03 REVIEW FIX adapter）", () => {
  it("API-01：entry ACCOUNT_INACTIVE → 401 ACCOUNT_INACTIVE，零 mutation", async () => {
    getVerifiedSession.mockResolvedValue({ ok: false, reason: "ACCOUNT_INACTIVE" });

    const response = await callPost({ documentIds: ["doc-1"] });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({ error: "未登录或账号不可用", code: "ACCOUNT_INACTIVE" });
    expect(recordReconsentAcceptances).not.toHaveBeenCalled();
  });

  it("API-02：ACTIVE entry → recordReconsentAcceptances 被调用，成功 shape 不变", async () => {
    const response = await callPost({ documentIds: ["doc-terms-2", "doc-privacy-1"] });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ created: 2, skipped: 0, compliant: true });
    expect(recordReconsentAcceptances).toHaveBeenCalledWith({
      userId: "user-1",
      documentIds: ["doc-terms-2", "doc-privacy-1"],
    });
  });

  it("API-03：race-lost AUTH_ACCOUNT_INACTIVE → 与 entry inactive 同形 401", async () => {
    const { RbacError } = await import("@/lib/rbac/errors");
    recordReconsentAcceptances.mockRejectedValue(
      new RbacError("AUTH_ACCOUNT_INACTIVE", "账号当前不可用"),
    );

    const response = await callPost({ documentIds: ["doc-terms-2"] });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({ error: "未登录或账号不可用", code: "ACCOUNT_INACTIVE" });
    // 绝不向该 endpoint 泄露 AUTH_ACCOUNT_INACTIVE machine code
    expect(JSON.stringify(body)).not.toContain("AUTH_ACCOUNT_INACTIVE");
  });

  it("API-04：LEGAL_DOCUMENT_VERSION_CHANGED → 既有 governance status/code 保留", async () => {
    const { GovernanceError } = await import("@/lib/governance/domain-errors");
    recordReconsentAcceptances.mockRejectedValue(
      new GovernanceError("LEGAL_DOCUMENT_VERSION_CHANGED", "协议版本已更新，请重新加载"),
    );

    const response = await callPost({ documentIds: ["doc-old"] });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({ error: "协议版本已更新，请重新加载", code: "LEGAL_DOCUMENT_VERSION_CHANGED" });
  });

  it("API-05：validation failure → 400 VALIDATION", async () => {
    const response = await callPost({ documentIds: [] });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ code: "VALIDATION" });
    expect(recordReconsentAcceptances).not.toHaveBeenCalled();
  });

  it("API-06：rate limit → 429 RATE_LIMITED", async () => {
    isRateLimited.mockResolvedValue({ limited: true });

    const response = await callPost({ documentIds: ["doc-terms-2"] });
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body).toMatchObject({ code: "RATE_LIMITED" });
    expect(recordReconsentAcceptances).not.toHaveBeenCalled();
  });

  it("API-07：成功响应 private,no-store + created/skipped/compliant 合同", async () => {
    const response = await callPost({ documentIds: ["doc-terms-2"] });

    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      created: 2,
      skipped: 0,
      compliant: true,
    });
  });
});
