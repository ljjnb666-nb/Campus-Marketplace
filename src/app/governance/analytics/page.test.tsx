import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  requireUser: vi.fn(), loadAuthorizationContext: vi.fn(),
  campusList: vi.fn(), campusFind: vi.fn(), overview: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));
vi.mock("@/lib/server-auth", () => ({ requireUser: mock.requireUser }));
vi.mock("@/lib/rbac/service", () => ({ loadAuthorizationContext: mock.loadAuthorizationContext }));
vi.mock("@/lib/prisma", () => ({ prisma: { campus: {
  findMany: mock.campusList, findUnique: mock.campusFind,
}} }));
vi.mock("@/lib/analytics/analytics-overview-query", () => ({
  loadAuthorizedAnalyticsOverview: mock.overview,
}));
vi.mock("next/navigation", () => ({ notFound: mock.notFound }));

import GovernanceAnalyticsPage from "@/app/governance/analytics/page";

const params = (query: Record<string, string | string[] | undefined> = {}) =>
  ({ searchParams: Promise.resolve(query) });
function actor(scope: "GLOBAL" | "CAMPUS" = "CAMPUS", activeCampusIds = ["A"], permissions = ["analytics.read"]) {
  mock.requireUser.mockResolvedValue({ id: "operator" });
  mock.loadAuthorizationContext.mockResolvedValue({
    userId: "operator", accountActive: true, activeCampusIds,
    grants: [{ scope, campusId: scope === "GLOBAL" ? null : "A", roleKey: "ANALYTICS", permissionKeys: permissions }],
  });
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("10J leaf authorization and input safety", () => {
  it("denies unrelated rights with zero metadata or analytics queries", async () => {
    actor("GLOBAL", [], ["audit.read", "risk.read", "operations.overview"]);
    await expect(GovernanceAnalyticsPage(params())).rejects.toThrow("NOT_FOUND");
    expect(mock.campusList).not.toHaveBeenCalled();
    expect(mock.overview).not.toHaveBeenCalled();
  });

  it("campus-only analyst defaults to active grant, no global discovery", async () => {
    actor();
    mock.campusList.mockResolvedValue([{ id: "A", name: "校区甲" }]);
    mock.overview.mockResolvedValue({
      campusId: "A", campusName: "校区甲", periodDays: 30,
      currentSupply: { total: 0, product: 0, service: 0, rental: 0, capturedAt: "2026-10-08T00:00:00Z" },
      metrics: [], projectionVersion: 3, from: "2026-09-08T00:00:00Z", until: "2026-10-08T00:00:00Z",
    });
    render(await GovernanceAnalyticsPage(params()));
    expect(screen.getByRole("heading", { name: "校园交易分析" })).toBeTruthy();
    expect(mock.campusList).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["A"] } } }));
    expect(mock.overview).toHaveBeenCalledWith({ actorId: "operator", campusId: "A", periodDays: 30 });
    expect(screen.queryByText(/平台收入总额|GMV 汇总/)).toBeNull();
  });

  it("forged campus and unsupported query keys reject before metrics", async () => {
    actor();
    for (const query of [
      { campusId: "B" }, { campusId: "" }, { campusId: ["A", "B"] },
      { campusId: "A", days: "99" }, { campusId: "A", days: ["7", "30"] },
      { campusId: "A", other: "x" }, { campusId: "x".repeat(129) },
    ]) {
      mock.campusList.mockResolvedValue([{ id: "A", name: "校区甲" }]);
      await expect(GovernanceAnalyticsPage(params(query))).rejects.toThrow("NOT_FOUND");
    }
    expect(mock.overview).not.toHaveBeenCalled();
  });

  it("GLOBAL admin may select exact campus and 7-day window; no all-campus sum", async () => {
    actor("GLOBAL", []);
    mock.campusList.mockResolvedValue([{ id: "A", name: "校区甲" }]);
    mock.overview.mockResolvedValue(null);
    render(await GovernanceAnalyticsPage(params({ campusId: "A", days: "7" })));
    expect(mock.overview).toHaveBeenCalledWith({ actorId: "operator", campusId: "A", periodDays: 7 });
    expect(mock.campusList).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  it("no campus is an explicit empty state, never an unscoped analytics query", async () => {
    actor("GLOBAL", []);
    mock.campusList.mockResolvedValue([]);
    render(await GovernanceAnalyticsPage(params()));
    expect(screen.getByText("当前没有可以分析的授权校区。")).toBeTruthy();
    expect(mock.overview).not.toHaveBeenCalled();
  });
});
