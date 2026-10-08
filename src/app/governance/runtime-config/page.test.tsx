import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), loadAuthorizationContext: vi.fn(),
  findCampus: vi.fn(), listCampuses: vi.fn(),
  loadRuntimeConfigForOperator: vi.fn(), loadEffectiveRuntimeConfig: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));
vi.mock("@/lib/server-auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/rbac/service", () => ({ loadAuthorizationContext: mocks.loadAuthorizationContext }));
vi.mock("@/repositories/runtime-config-ui-campus-repository", () => ({
  findRuntimeConfigUiCampusById: mocks.findCampus,
  listRuntimeConfigUiCampuses: mocks.listCampuses,
}));
vi.mock("@/lib/runtime-config/runtime-config-operator-query", () => ({
  loadRuntimeConfigForOperator: mocks.loadRuntimeConfigForOperator,
}));
vi.mock("@/lib/runtime-config/runtime-config-query", () => ({
  loadEffectiveRuntimeConfig: mocks.loadEffectiveRuntimeConfig,
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/components/governance/runtime-config-console", () => ({
  RuntimeConfigConsole: ({ campusId }: { campusId: string | null }) =>
    <div data-testid="runtime-console">{campusId ?? "GLOBAL"}</div>,
}));

import GovernanceRuntimeConfigPage from "@/app/governance/runtime-config/page";

const params = (campusId?: string | string[]) =>
  ({ searchParams: Promise.resolve(campusId === undefined ? {} : { campusId }) });
function actor(grants: Array<{ scope: "GLOBAL" | "CAMPUS"; campusId: string | null; permissionKeys: string[] }>, memberships: string[] = []) {
  mocks.requireUser.mockResolvedValue({ id: "operator" });
  mocks.loadAuthorizationContext.mockResolvedValue({
    userId: "operator", accountActive: true, activeCampusIds: memberships,
    grants: grants.map((g, i) => ({ ...g, roleKey: `R${i}` })),
  });
  mocks.findCampus.mockResolvedValue({ id: "A", name: "校区A" });
  mocks.listCampuses.mockResolvedValue([{ id: "A", name: "校区A" }]);
  mocks.loadRuntimeConfigForOperator.mockResolvedValue({
    key: "RISK_SIGNAL_EVIDENCE_LIMIT", scopeKey: "GLOBAL", currentValue: null,
    currentVersion: 0, revisions: [],
  });
  mocks.loadEffectiveRuntimeConfig.mockResolvedValue({
    key: "RISK_SIGNAL_EVIDENCE_LIMIT", value: 50, source: "DEFAULT", version: null,
  });
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("10H runtime config leaf permission and scope", () => {
  it("GLOBAL manager loads authorized GLOBAL config, no campus metadata lookup", async () => {
    actor([{ scope: "GLOBAL", campusId: null, permissionKeys: ["runtime.config.manage"] }]);
    render(await GovernanceRuntimeConfigPage(params()));
    expect(screen.getByTestId("runtime-console").textContent).toBe("GLOBAL");
    expect(mocks.loadRuntimeConfigForOperator).toHaveBeenCalledWith({
      actorId: "operator", key: "RISK_SIGNAL_EVIDENCE_LIMIT", campusId: null,
    });
    expect(mocks.findCampus).not.toHaveBeenCalled();
  });

  it("campus-only manager defaults to its active campus, never GLOBAL", async () => {
    actor([{ scope: "CAMPUS", campusId: "A", permissionKeys: ["runtime.config.manage"] }], ["A"]);
    render(await GovernanceRuntimeConfigPage(params()));
    expect(screen.getByTestId("runtime-console").textContent).toBe("A");
    expect(mocks.loadRuntimeConfigForOperator).toHaveBeenCalledWith(expect.objectContaining({ campusId: "A" }));
    expect(mocks.listCampuses).toHaveBeenCalledWith({ global: false, campusIds: ["A"] });
  });

  it("forged GLOBAL, other campus, array scope or overlength scope all fail before DB access", async () => {
    actor([{ scope: "CAMPUS", campusId: "A", permissionKeys: ["runtime.config.manage"] }], ["A"]);
    for (const invalid of ["", "B", ["A", "B"], "X".repeat(129)]) {
      await expect(GovernanceRuntimeConfigPage(params(invalid))).rejects.toThrow("NOT_FOUND");
    }
    expect(mocks.findCampus).not.toHaveBeenCalled();
    expect(mocks.listCampuses).not.toHaveBeenCalled();
    expect(mocks.loadRuntimeConfigForOperator).not.toHaveBeenCalled();
  });

  it("unrelated governance rights cannot discover runtime config rows", async () => {
    actor([{ scope: "GLOBAL", campusId: null, permissionKeys: ["feature.flags.manage"] }]);
    await expect(GovernanceRuntimeConfigPage(params())).rejects.toThrow("NOT_FOUND");
    expect(mocks.loadRuntimeConfigForOperator).not.toHaveBeenCalled();
  });

  it("nonexistent campus denies before querying the config", async () => {
    actor([{ scope: "GLOBAL", campusId: null, permissionKeys: ["runtime.config.manage"] }]);
    mocks.findCampus.mockResolvedValueOnce(null);
    await expect(GovernanceRuntimeConfigPage(params("absent"))).rejects.toThrow("NOT_FOUND");
    expect(mocks.loadRuntimeConfigForOperator).not.toHaveBeenCalled();
  });
});
