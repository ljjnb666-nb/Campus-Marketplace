import { beforeEach, describe, expect, it, vi } from "vitest";
import { appealError } from "@/lib/appeals/errors";

const {
  getAppealEligibleSession,
  isRateLimited,
  submitAppeal,
  loadAppellantAppealSelfDto,
} = vi.hoisted(() => ({
  getAppealEligibleSession: vi.fn(),
  isRateLimited: vi.fn(),
  submitAppeal: vi.fn(),
  loadAppellantAppealSelfDto: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  getAppealEligibleSession,
  APPEAL_ELIGIBLE_SESSION_HTTP_STATUS: { UNAUTHENTICATED: 401, ACCOUNT_INELIGIBLE: 401 },
}));

vi.mock("@/lib/rate-limit", () => ({
  isRateLimited,
}));

// validators/appeal 依赖真实 APPEAL_STATEMENT_MAX_LENGTH，保留其余导出
vi.mock("@/lib/appeals/appeal-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/appeals/appeal-service")>();
  return { ...actual, submitAppeal };
});

vi.mock("@/lib/appeals/appeal-query", () => ({
  loadAppellantAppealSelfDto,
}));

import { POST } from "@/app/api/appeals/route";

const ELIGIBLE = { ok: true, user: { id: "user-1" } } as const;

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/appeals", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const SELF_DTO = {
  id: "ap-1",
  enforcementActionId: "ea-1",
  status: "SUBMITTED",
  statement: "说明",
  decisionReasonCode: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  reviewedAt: null,
};

describe("POST /api/appeals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isRateLimited.mockResolvedValue({ limited: false, remaining: 4 });
    loadAppellantAppealSelfDto.mockResolvedValue(SELF_DTO);
  });

  it("HTTP-1: unauthenticated submit is denied with 401", async () => {
    getAppealEligibleSession.mockResolvedValue({ ok: false, reason: "UNAUTHENTICATED" });

    const response = await POST(jsonRequest({ enforcementActionId: "ea-1", statement: "x" }) as never);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "未登录或账号不可用",
      code: "UNAUTHENTICATED",
    });
    expect(submitAppeal).not.toHaveBeenCalled();
  });

  it("HTTP-6: ineligible (erased/deleted/missing) session is denied with an opaque 401", async () => {
    getAppealEligibleSession.mockResolvedValue({ ok: false, reason: "ACCOUNT_INELIGIBLE" });

    const response = await POST(jsonRequest({ enforcementActionId: "ea-1", statement: "x" }) as never);

    expect(response.status).toBe(401);
    const body = await response.json();
    // 不暴露 deleted/erased 等具体状态词
    expect(JSON.stringify(body)).not.toContain("ERASED");
    expect(JSON.stringify(body)).not.toContain("DELETED");
    expect(submitAppeal).not.toHaveBeenCalled();
  });

  it("HTTP-2: SUSPENDED appellant can submit against their own ACCOUNT_SUSPEND", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);
    submitAppeal.mockResolvedValue({ appeal: { id: "ap-1", enforcementActionId: "ea-1", status: "SUBMITTED", createdAt: new Date() } });

    const response = await POST(jsonRequest({ enforcementActionId: "ea-1", statement: "申诉说明" }) as never);

    expect(response.status).toBe(201);
    expect(submitAppeal).toHaveBeenCalledWith({
      callerUserId: "user-1",
      enforcementActionId: "ea-1",
      statement: "申诉说明",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("HTTP-3: ACTIVE appellant can submit against MEMBERSHIP_SUSPEND / MARKETPLACE_RESTRICT", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);
    submitAppeal.mockResolvedValue({ appeal: { id: "ap-1", enforcementActionId: "ea-1", status: "SUBMITTED", createdAt: new Date() } });

    const response = await POST(jsonRequest({ enforcementActionId: "ea-m", statement: "申诉" }) as never);

    expect(response.status).toBe(201);
    expect(submitAppeal).toHaveBeenCalledTimes(1);
  });

  it("HTTP-4: client-supplied identity fields are rejected by the strict schema", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);

    const response = await POST(
      jsonRequest({
        enforcementActionId: "ea-1",
        statement: "申诉",
        callerUserId: "victim",
        userId: "victim",
        appellantId: "victim",
        targetUserId: "victim",
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(submitAppeal).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON content type with 415 (CSRF form-post layer)", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);

    const response = await POST(
      new Request("http://localhost/api/appeals", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "enforcementActionId=ea-1&statement=x",
      }) as never,
    );

    expect(response.status).toBe(415);
    expect(submitAppeal).not.toHaveBeenCalled();
  });

  it("BODY-1: Content-Length > 8192 → early 413 before reading the body", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);

    const response = await POST(
      new Request("http://localhost/api/appeals", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(9 * 1024) },
        body: "{}",
      }) as never,
    );

    expect(response.status).toBe(413);
    expect(submitAppeal).not.toHaveBeenCalled();
  });

  it("BODY-2 (blocker reproduction): Content-Length absent + actual body > 8192 bytes → 413, submitAppeal NOT called", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);
    // 不带 content-length 头：header fast-path 被跳过，必须由流式字节计数拦截
    const oversized = JSON.stringify({
      enforcementActionId: "ea-1",
      statement: "a".repeat(9000),
    });
    expect(new TextEncoder().encode(oversized).length).toBeGreaterThan(8192);

    const response = await POST(
      new Request("http://localhost/api/appeals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversized,
      }) as never,
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(submitAppeal).not.toHaveBeenCalled();
  });

  it("BODY-3: Content-Length claims small while actual body > 8192 bytes → still 413", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);
    const oversized = JSON.stringify({
      enforcementActionId: "ea-1",
      statement: "a".repeat(9000),
    });

    const response = await POST(
      new Request("http://localhost/api/appeals", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "16" },
        body: oversized,
      }) as never,
    );

    expect(response.status).toBe(413);
    expect(submitAppeal).not.toHaveBeenCalled();
  });

  it("BODY-4: actual body <= 8192 with valid JSON keeps the normal submit flow (201)", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);
    submitAppeal.mockResolvedValue({
      appeal: { id: "ap-1", enforcementActionId: "ea-1", status: "SUBMITTED", createdAt: new Date() },
    });
    const nearBoundary = JSON.stringify({
      enforcementActionId: "ea-1",
      statement: "a".repeat(2000),
    });
    expect(new TextEncoder().encode(nearBoundary).length).toBeLessThanOrEqual(8192);

    const response = await POST(
      new Request("http://localhost/api/appeals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: nearBoundary,
      }) as never,
    );

    expect(response.status).toBe(201);
    expect(submitAppeal).toHaveBeenCalledWith({
      callerUserId: "user-1",
      enforcementActionId: "ea-1",
      statement: "a".repeat(2000),
    });
  });

  it("BODY-5: multibyte UTF-8 body counted by BYTES not characters（9000 bytes / 3000+ chars）→ 413", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);
    // "中" = 3 UTF-8 bytes：3000 个字符远小于 8192 字符，但实际传输 > 8192 字节
    const multibyte = JSON.stringify({
      enforcementActionId: "ea-1",
      statement: "中".repeat(3000),
    });
    expect(multibyte.length).toBeLessThan(8192); // JS 字符数视角"未超限"
    expect(new TextEncoder().encode(multibyte).length).toBeGreaterThan(8192); // 字节视角超限

    const response = await POST(
      new Request("http://localhost/api/appeals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: multibyte,
      }) as never,
    );

    expect(response.status).toBe(413);
    expect(submitAppeal).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON with 400", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);

    const response = await POST(
      new Request("http://localhost/api/appeals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{broken",
      }) as never,
    );

    expect(response.status).toBe(400);
  });

  it("returns 429 when the appeal:submit bucket is exhausted", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);
    isRateLimited.mockResolvedValue({ limited: true, remaining: 0 });

    const response = await POST(jsonRequest({ enforcementActionId: "ea-1", statement: "x" }) as never);

    expect(response.status).toBe(429);
    expect(isRateLimited).toHaveBeenCalledWith({
      key: "appeal:submit:user-1",
      limit: 5,
      windowMs: 60 * 60 * 1000,
    });
    expect(submitAppeal).not.toHaveBeenCalled();
  });

  it("HTTP-5: another user's enforcementAction maps to the unified 404 anti-enumeration contract", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);
    submitAppeal.mockRejectedValue(appealError("APPEAL_NOT_OWNED"));

    const response = await POST(jsonRequest({ enforcementActionId: "ea-other", statement: "x" }) as never);

    expect(response.status).toBe(404);
    const body = await response.json();
    // 与 APPEAL_NOT_FOUND 同款文案；响应体不回显 machine code
    expect(body).toEqual({ error: "申诉不存在" });
  });

  it("HTTP-7: duplicate appeal maps to 409", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);
    submitAppeal.mockRejectedValue(appealError("APPEAL_ALREADY_EXISTS"));

    const response = await POST(jsonRequest({ enforcementActionId: "ea-1", statement: "x" }) as never);

    expect(response.status).toBe(409);
  });

  it("HTTP-10: the self response never contains reviewer/decision internal fields", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);
    submitAppeal.mockResolvedValue({ appeal: { id: "ap-1", enforcementActionId: "ea-1", status: "SUBMITTED", createdAt: new Date() } });

    const response = await POST(jsonRequest({ enforcementActionId: "ea-1", statement: "x" }) as never);

    const raw = JSON.stringify(await response.json());
    for (const forbidden of ["decisionNote", "reviewedById", "reviewer"]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
