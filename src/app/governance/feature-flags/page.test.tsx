import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, loadAuthorizationContext, findUnique, findMany, loadFeatureFlagConsoleRows, notFound } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  loadFeatureFlagConsoleRows: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));
vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/rbac/service", () => ({ loadAuthorizationContext }));
vi.mock("@/lib/prisma", () => ({ prisma: { campus: { findUnique, findMany } } }));
vi.mock("@/lib/feature-flags/feature-flag-ui-query", () => ({ loadFeatureFlagConsoleRows }));
vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/components/governance/feature-flag-console", () => ({
  FeatureFlagConsole: ({ campusId, canManageGlobal }: { campusId: string | null; canManageGlobal: boolean }) =>
    <div data-testid="feature-flag-console">{campusId ?? "GLOBAL"} / {String(canManageGlobal)}</div>,
}));

import GovernanceFeatureFlagsPage from "@/app/governance/feature-flags/page";

function actor(grants: Array<{ scope: "GLOBAL" | "CAMPUS"; campusId: string | null; permissionKeys: string[] }>, activeCampusIds: string[] = []) {
  requireUser.mockResolvedValue({ id: "op-1" });
  loadAuthorizationContext.mockResolvedValue({
    userId: "op-1", accountActive: true, activeCampusIds,
    grants: grants.map((grant, i) => ({ roleKey: `R${i}`, ...grant })),
  });
  findUnique.mockResolvedValue({ id: "A", name: "校区 A" });
  findMany.mockResolvedValue([{ id: "A", name: "校区 A" }]);
  loadFeatureFlagConsoleRows.mockResolvedValue([]);
}
const params = (campusId?: string) => ({ searchParams: Promise.resolve(campusId === undefined ? {} : { campusId }) });

afterEach(() => {
  cleanup(); vi.clearAllMocks();
});

describe("Phase 10G /governance/feature-flags self-guard", () => {
  it("G10: GLOBAL manager can load GLOBAL without memberships", async () => {
    actor([{ scope: "GLOBAL", campusId: null, permissionKeys: ["feature.flags.manage"] }]);
    render(await GovernanceFeatureFlagsPage(params()));
    expect(screen.getByTestId("feature-flag-console").textContent).toContain("GLOBAL");
    expect(loadFeatureFlagConsoleRows).toHaveBeenCalledWith({ actorId: "op-1", campusId: null });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("G11: campus-only permission defaults to authorized exact campus; never GLOBAL", async () => {
    actor([{ scope: "CAMPUS", campusId: "A", permissionKeys: ["feature.flags.manage"] }], ["A"]);
    render(await GovernanceFeatureFlagsPage(params()));
    expect(loadFeatureFlagConsoleRows).toHaveBeenCalledWith({ actorId: "op-1", campusId: "A" });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["A"] } },
    }));
  });

  it("G12: forged cross-campus/global URL never reaches campus DB or flag authority", async () => {
    actor([{ scope: "CAMPUS", campusId: "A", permissionKeys: ["feature.flags.manage"] }], ["A"]);
    await expect(GovernanceFeatureFlagsPage(params("B"))).rejects.toThrow("NOT_FOUND");
    await expect(GovernanceFeatureFlagsPage(params(""))).rejects.toThrow("NOT_FOUND");
    expect(findUnique).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(loadFeatureFlagConsoleRows).not.toHaveBeenCalled();
  });

  it("G13: unrelated governance permissions cannot open sibling", async () => {
    actor([{ scope: "GLOBAL", campusId: null, permissionKeys: ["operations.overview"] }]);
    await expect(GovernanceFeatureFlagsPage(params())).rejects.toThrow("NOT_FOUND");
    expect(loadFeatureFlagConsoleRows).not.toHaveBeenCalled();
  });

  it("G14: missing campus is denied, rather than claiming an available scope", async () => {
    actor([{ scope: "GLOBAL", campusId: null, permissionKeys: ["feature.flags.manage"] }]);
    findUnique.mockResolvedValueOnce(null);
    await expect(GovernanceFeatureFlagsPage(params("missing"))).rejects.toThrow("NOT_FOUND");
    expect(loadFeatureFlagConsoleRows).not.toHaveBeenCalled();
  });
});
