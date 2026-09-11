import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { appealError } from "@/lib/appeals/errors";

const {
  getAppealEligibleSession,
  isRateLimited,
  withdrawAppeal,
  loadAppellantAppealSelfDto,
} = vi.hoisted(() => ({
  getAppealEligibleSession: vi.fn(),
  isRateLimited: vi.fn(),
  withdrawAppeal: vi.fn(),
  loadAppellantAppealSelfDto: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  getAppealEligibleSession,
  APPEAL_ELIGIBLE_SESSION_HTTP_STATUS: { UNAUTHENTICATED: 401, ACCOUNT_INELIGIBLE: 401 },
}));

vi.mock("@/lib/rate-limit", () => ({
  isRateLimited,
}));

vi.mock("@/lib/appeals/appeal-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/appeals/appeal-service")>();
  return { ...actual, withdrawAppeal };
});

vi.mock("@/lib/appeals/appeal-query", () => ({
  loadAppellantAppealSelfDto,
}));

import { POST } from "@/app/api/appeals/[id]/withdraw/route";

const SELF_DTO = {
  id: "ap-1",
  enforcementActionId: "ea-1",
  status: "WITHDRAWN",
  statement: "说明",
  decisionReasonCode: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T01:00:00.000Z",
  reviewedAt: null,
};

function request(id: string) {
  return new Request(`http://localhost/api/appeals/${id}/withdraw`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }) as unknown as NextRequest;
}

describe("POST /api/appeals/[id]/withdraw", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isRateLimited.mockResolvedValue({ limited: false, remaining: 9 });
    loadAppellantAppealSelfDto.mockResolvedValue(SELF_DTO);
  });

  it("returns 401 without an eligible session", async () => {
    getAppealEligibleSession.mockResolvedValue({ ok: false, reason: "UNAUTHENTICATED" });

    const response = await POST(request("ap-1"), {
      params: Promise.resolve({ id: "ap-1" }),
    } as never);

    expect(response.status).toBe(401);
    expect(withdrawAppeal).not.toHaveBeenCalled();
  });

  it("HTTP-8: withdraws own SUBMITTED appeal and returns the frozen self DTO", async () => {
    getAppealEligibleSession.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    withdrawAppeal.mockResolvedValue({
      appeal: { id: "ap-1", enforcementActionId: "ea-1", status: "WITHDRAWN", createdAt: new Date() },
    });

    const response = await POST(request("ap-1"), {
      params: Promise.resolve({ id: "ap-1" }),
    } as never);

    expect(response.status).toBe(200);
    expect(withdrawAppeal).toHaveBeenCalledWith({
      callerUserId: "user-1",
      appealId: "ap-1",
    });
    const body = await response.json();
    expect(body.appeal.status).toBe("WITHDRAWN");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("HTTP-9: withdrawing an IN_REVIEW/terminal appeal maps to 409", async () => {
    getAppealEligibleSession.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    withdrawAppeal.mockRejectedValue(appealError("APPEAL_INVALID_TRANSITION"));

    const response = await POST(request("ap-1"), {
      params: Promise.resolve({ id: "ap-1" }),
    } as never);

    expect(response.status).toBe(409);
  });

  it("maps another user's appealId to the unified 404 anti-enumeration contract", async () => {
    getAppealEligibleSession.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    withdrawAppeal.mockRejectedValue(appealError("APPEAL_NOT_OWNED"));

    const response = await POST(request("ap-other"), {
      params: Promise.resolve({ id: "ap-other" }),
    } as never);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "申诉不存在" });
  });

  it("rejects a non-JSON content type with 415", async () => {
    getAppealEligibleSession.mockResolvedValue({ ok: true, user: { id: "user-1" } });

    const response = await POST(
      new Request("http://localhost/api/appeals/ap-1/withdraw", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "x",
      }) as unknown as NextRequest,
      { params: Promise.resolve({ id: "ap-1" }) } as never,
    );

    expect(response.status).toBe(415);
    expect(withdrawAppeal).not.toHaveBeenCalled();
  });

  it("returns 429 when the appeal:withdraw bucket is exhausted", async () => {
    getAppealEligibleSession.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    isRateLimited.mockResolvedValue({ limited: true, remaining: 0 });

    const response = await POST(request("ap-1"), {
      params: Promise.resolve({ id: "ap-1" }),
    } as never);

    expect(response.status).toBe(429);
    expect(isRateLimited).toHaveBeenCalledWith({
      key: "appeal:withdraw:user-1",
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });
  });
});
