import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { search, transaction, createMany, upsert } = vi.hoisted(() => ({
  search: vi.fn(), transaction: vi.fn(), createMany: vi.fn(), upsert: vi.fn(),
}));
vi.mock("@/repositories/search-repository", () => ({ getSearchResults: search }));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: transaction },
}));
import {
  captureCompletedSearch, createSearchTelemetryTicket, eligibleSearchKeyword,
  eligibleSubmissionHeaders, recordCompletedSearchTx, validateSearchTelemetryTicket,
} from "@/lib/analytics/search-telemetry";

const NOW = new Date("2026-10-08T12:37:00.000Z");
const headers = new Headers({
  origin: "https://market.example",
  "sec-fetch-site": "same-origin",
  "sec-fetch-user": "?1",
  "user-agent": "Mozilla/5.0",
});
beforeEach(() => {
  vi.stubEnv("SEARCH_TELEMETRY_CAPTURE", "enabled");
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-of-sufficient-length-for-hmac");
  vi.stubEnv("NEXTAUTH_URL", "https://market.example");
  search.mockReset();
  createMany.mockReset().mockResolvedValue({ count: 1 });
  upsert.mockReset().mockResolvedValue({});
  transaction.mockReset().mockImplementation(fn => fn({
    searchTelemetryClaim: { createMany },
    searchTelemetryHour: { upsert },
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe("R2a search telemetry privacy and gating", () => {
  it("is disabled by default and no token is minted", async () => {
    vi.stubEnv("SEARCH_TELEMETRY_CAPTURE", "");
    expect(createSearchTelemetryTicket()).toBe("");
    expect(await captureCompletedSearch({ keyword: "bike", ticket: "x", headers }))
      .toBe("DISABLED");
    expect(search).not.toHaveBeenCalled();
  });

  it("requires valid signed fresh ticket and has no user-controlled campus attribution", () => {
    const token = createSearchTelemetryTicket(NOW.getTime());
    expect(validateSearchTelemetryTicket(token, NOW.getTime())).toMatch(/^[a-f0-9]{64}$/);
    expect(validateSearchTelemetryTicket(token, NOW.getTime() + 20 * 60_000 + 1)).toBeNull();
    expect(validateSearchTelemetryTicket(token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"), NOW.getTime()))
      .toBeNull();
    expect(validateSearchTelemetryTicket("anything", NOW.getTime())).toBeNull();
  });

  it("excludes bots, cross-site posts, no activation and control-character keywords", () => {
    expect(eligibleSearchKeyword("")).toBe(false);
    expect(eligibleSearchKeyword("a".repeat(121))).toBe(false);
    expect(eligibleSearchKeyword("hi\n")).toBe(false);
    expect(eligibleSubmissionHeaders(headers)).toBe(true);
    for (const changes of [
      { "sec-fetch-user": "" }, { "sec-fetch-site": "cross-site" },
      { "user-agent": "Googlebot" }, { origin: "https://evil.example" },
    ]) {
      const h = new Headers(headers);
      for (const [k, v] of Object.entries(changes)) h.set(k, v);
      expect(eligibleSubmissionHeaders(h)).toBe(false);
    }
  });

  it("records server-computed zero once; stores no keyword, header or identity", async () => {
    search.mockResolvedValue({ products: [], services: [], errands: [], users: [] });
    const result = await captureCompletedSearch({
      keyword: "  never-seen-bike  ",
      ticket: createSearchTelemetryTicket(NOW.getTime()), headers, now: NOW,
    });
    expect(result).toBe("RECORDED");
    expect(search).toHaveBeenCalledWith("never-seen-bike");
    expect(createMany).toHaveBeenCalledWith({
      data: [{ digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        expiresAt: new Date("2026-10-09T12:37:00.000Z") }],
      skipDuplicates: true,
    });
    expect(upsert).toHaveBeenCalledWith({
      where: { hourStart: new Date("2026-10-08T12:00:00.000Z") },
      create: {
        hourStart: new Date("2026-10-08T12:00:00.000Z"),
        attempts: BigInt(1), zeroResults: BigInt(1), expiresAt: new Date("2026-11-08T12:00:00.000Z"),
      },
      update: { attempts: { increment: BigInt(1) }, zeroResults: { increment: BigInt(1) } },
    });
    const payload = JSON.stringify(createMany.mock.calls) + String(upsert.mock.calls);
    expect(payload).not.toContain("never-seen-bike");
    expect(payload).not.toContain("market.example");
  });

  it("does not count search error or telemetry failure as zero", async () => {
    const token = createSearchTelemetryTicket(NOW.getTime());
    search.mockRejectedValueOnce(new Error("PRIVATE QUERY MUST NOT LOG"));
    expect(await captureCompletedSearch({ keyword: "secret", ticket: token, headers, now: NOW }))
      .toBe("FAILED");
    expect(transaction).not.toHaveBeenCalled();
    search.mockResolvedValue({ products: [{ id: "p" }], services: [], errands: [], users: [] });
    transaction.mockRejectedValueOnce(new Error("db unavailable"));
    expect(await captureCompletedSearch({ keyword: "secret", ticket: token, headers, now: NOW }))
      .toBe("FAILED");
  });

  it("duplicate claim never increments and rollback is enforced by caller transaction", async () => {
    createMany.mockResolvedValueOnce({ count: 0 });
    const result = await recordCompletedSearchTx({
      searchTelemetryClaim: { createMany }, searchTelemetryHour: { upsert },
    } as never, {
      digest: "f".repeat(64), zero: true, now: NOW,
      hourStart: new Date("2026-10-08T12:00:00.000Z"),
    });
    expect(result).toBe("DUPLICATE");
    expect(upsert).not.toHaveBeenCalled();
  });
});
