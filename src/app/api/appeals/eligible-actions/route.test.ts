import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAppealEligibleSession,
  isRateLimited,
  listEligibleAppealActions,
} = vi.hoisted(() => ({
  getAppealEligibleSession: vi.fn(),
  isRateLimited: vi.fn(),
  listEligibleAppealActions: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  getAppealEligibleSession,
  APPEAL_ELIGIBLE_SESSION_HTTP_STATUS: { UNAUTHENTICATED: 401, ACCOUNT_INELIGIBLE: 401 },
}));

vi.mock("@/lib/rate-limit", () => ({
  isRateLimited,
}));

vi.mock("@/lib/appeals/appeal-query", () => ({
  listEligibleAppealActions,
}));

import { GET } from "@/app/api/appeals/eligible-actions/route";
import { encodeAppealCursor } from "@/validators/appeal";

const ELIGIBLE = { ok: true, user: { id: "user-1" } } as const;

function request(query = "") {
  return new Request(`http://localhost/api/appeals/eligible-actions${query}`);
}

describe("GET /api/appeals/eligible-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isRateLimited.mockResolvedValue({ limited: false, remaining: 29 });
    listEligibleAppealActions.mockResolvedValue({ items: [], nextCursor: null });
  });

  it("returns 401 without an eligible session", async () => {
    getAppealEligibleSession.mockResolvedValue({ ok: false, reason: "UNAUTHENTICATED" });

    const response = await GET(request() as never);

    expect(response.status).toBe(401);
    expect(listEligibleAppealActions).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("AUTH-3G: a SUSPENDED session is allowed to discover its own punitive actions", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);
    listEligibleAppealActions.mockResolvedValue({
      items: [
        {
          enforcementActionId: "ea-1",
          type: "ACCOUNT_SUSPEND",
          scopeKind: "GLOBAL",
          createdAt: "2026-01-01T00:00:00.000Z",
          appeal: null,
        },
      ],
      nextCursor: null,
    });

    const response = await GET(request() as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
    expect(listEligibleAppealActions).toHaveBeenCalledWith({
      targetUserId: "user-1",
      cursor: undefined,
      limit: 25,
    });
  });

  it("charges every page request to the same appeal:list bucket", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);

    await GET(request("?cursor=abc") as never);

    expect(isRateLimited).toHaveBeenCalledWith({
      key: "appeal:list:user-1",
      limit: 30,
      windowMs: 60 * 1000,
    });
  });

  it("returns 400 for an invalid ?limit (DISCOVERY 边界)", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);

    for (const bad of ["0", "51", "abc", "1.5"]) {
      const response = await GET(request(`?limit=${bad}`) as never);
      expect(response.status).toBe(400);
    }
    expect(listEligibleAppealActions).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed cursor (DISCOVERY-5A)", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);

    const response = await GET(request("?cursor=%%%invalid") as never);

    expect(response.status).toBe(400);
    expect(listEligibleAppealActions).not.toHaveBeenCalled();
  });

  it("DISCOVERY-5B: a well-formed client-crafted cursor is an untrusted position, never an ownership change", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);
    // 客户端自构造"指向他人 EA"的合法 cursor——路由照常进入 keyset 条件，
    // 但 targetId 仍是会话用户（他人行不可能返回）
    const forged = encodeAppealCursor({
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      id: "someone-elses-ea",
    });

    const response = await GET(request(`?cursor=${forged}`) as never);

    expect(response.status).toBe(200);
    expect(listEligibleAppealActions).toHaveBeenCalledWith({
      targetUserId: "user-1",
      cursor: { createdAt: new Date("2020-01-01T00:00:00.000Z"), id: "someone-elses-ea" },
      limit: 25,
    });
  });

  it("propagates a valid limit and cursor", async () => {
    getAppealEligibleSession.mockResolvedValue(ELIGIBLE);
    const cursor = encodeAppealCursor({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      id: "ea-25",
    });

    await GET(request(`?limit=50&cursor=${cursor}`) as never);

    expect(listEligibleAppealActions).toHaveBeenCalledWith({
      targetUserId: "user-1",
      cursor: { createdAt: new Date("2026-01-01T00:00:00.000Z"), id: "ea-25" },
      limit: 50,
    });
  });
});
