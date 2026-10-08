import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { capture, enabled } = vi.hoisted(() => ({
  capture: vi.fn(), enabled: vi.fn(),
}));
vi.mock("@/lib/analytics/search-telemetry", () => ({
  captureCompletedSearch: capture,
  searchTelemetryEnabled: enabled,
  eligibleSearchKeyword: (x: unknown) => typeof x === "string"
    && x.trim().length > 0 && x.trim().length <= 120
    && !/[\\u0000-\\u001f\\u007f]/.test(x),
}));
import { POST } from "@/app/search/submit/route";

beforeEach(() => { capture.mockReset().mockResolvedValue("RECORDED"); enabled.mockReset().mockReturnValue(true); });
afterEach(() => vi.restoreAllMocks());
function submit(body: string, headers: Record<string,string> = {}) {
  return POST(new NextRequest("https://market.example/search/submit", {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  }));
}
describe("R2a form submit", () => {
  it("keeps normal result navigation when telemetry capture fails", async () => {
    // The capture function itself promises to swallow failures. This test
    // asserts redirect after a resolved FAILED status, not uncaught exceptions.
    capture.mockReset().mockResolvedValue("FAILED");
    const response = await submit("q=bike&ticket=a");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://market.example/search?q=bike");
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("does not call capture while disabled", async () => {
    enabled.mockReturnValue(false);
    const response = await submit("q=hello&ticket=a");
    expect(response.status).toBe(303);
    expect(capture).not.toHaveBeenCalled();
  });

  it("rejects duplicate q, blank q, non-form and oversized bodies", async () => {
    for (const body of ["q=one&q=two&ticket=t", "q=%20%20&ticket=t", "q="]) {
      const response = await submit(body);
      expect(response.headers.get("location")).toBe("https://market.example/search");
    }
    const oversized = await submit("q=bike&ticket=t", { "content-length": "5000" });
    expect(oversized.status).toBe(303);
    expect(oversized.headers.get("location")).toBe("https://market.example/search");
    expect(capture).not.toHaveBeenCalled();
  });

  it("preserves ordinary search without a telemetry ticket or with ineligible keyword", async () => {
    const noTicket = await submit("q=bike");
    expect(noTicket.headers.get("location")).toBe("https://market.example/search?q=bike");
    const longKeyword = "b".repeat(121);
    const longSearch = await submit("q=" + longKeyword + "&ticket=invalid");
    expect(new URL(longSearch.headers.get("location")!).searchParams.get("q")).toBe(longKeyword);
    expect(capture).not.toHaveBeenCalled();
  });
});
