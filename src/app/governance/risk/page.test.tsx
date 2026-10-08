import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), loadAuthorizationContext: vi.fn(),
  loadAuthorizedRiskIntelligence: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));
vi.mock("@/lib/server-auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/rbac/service", () => ({ loadAuthorizationContext: mocks.loadAuthorizationContext }));
vi.mock("@/lib/risk/risk-intelligence", () => ({
  loadAuthorizedRiskIntelligence: mocks.loadAuthorizedRiskIntelligence,
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
import GovernanceRiskPage from "@/app/governance/risk/page";

function actor(
  grants: Array<{ scope: "GLOBAL" | "CAMPUS"; campusId: string | null; permissionKeys: string[] }>,
  activeCampusIds: string[] = [],
) {
  mocks.requireUser.mockResolvedValue({ id: "operator" });
  mocks.loadAuthorizationContext.mockResolvedValue({
    userId: "operator", accountActive: true, activeCampusIds,
    grants: grants.map((row, i) => ({ roleKey: "R" + i, ...row })),
  });
}
const search = (query: Record<string, string | string[] | undefined> = {}) => ({
  searchParams: Promise.resolve(query),
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("10I risk intelligence read-only governance leaf", () => {
  it("risk.read-only campus manager can access only its active campus without requiring enforcement.read", async () => {
    actor([{ scope: "CAMPUS", campusId: "A", permissionKeys: ["risk.read"] }], ["A"]);
    mocks.loadAuthorizedRiskIntelligence.mockResolvedValue({
      rulesetVersion: 1, scope: { kind: "CAMPUS", campusId: "A" },
      attentionLevel: "OBSERVE", activeSignalCount: 1, matchedRules: [
        { ruleId: "UNCONFIRMED_REPORT_CONTEXT", signalCount: 1 },
      ], evidence: [], evidenceTruncated: false, evaluatedAt: "2026-10-08T00:00:00Z",
    });
    render(await GovernanceRiskPage(search({ targetUserId: "target-1" })));
    expect(screen.getByRole("heading", { name: "持续关注" })).toBeTruthy();
    expect(screen.getByText("未核实举报（仅供参考）")).toBeTruthy();
    expect(mocks.loadAuthorizedRiskIntelligence).toHaveBeenCalledWith({
      access: { global: false, campusIds: ["A"] }, targetUserId: "target-1", campusId: "A",
    });
    expect(screen.queryByText(/风险评分|自动处罚/)).toBeNull();
  });

  it("a forged campus ID denies before the data loader, even with no target user", async () => {
    actor([{ scope: "CAMPUS", campusId: "A", permissionKeys: ["risk.read"] }], ["A"]);
    await expect(GovernanceRiskPage(search({ campusId: "B" }))).rejects.toThrow("NOT_FOUND");
    expect(mocks.loadAuthorizedRiskIntelligence).not.toHaveBeenCalled();
  });

  it("GLOBAL-only risk.read may evaluate an exact campus or ALL_SCOPES", async () => {
    actor([{ scope: "GLOBAL", campusId: null, permissionKeys: ["risk.read"] }]);
    mocks.loadAuthorizedRiskIntelligence.mockResolvedValue({
      rulesetVersion: 1, scope: { kind: "ALL_SCOPES" }, attentionLevel: "CLEAR",
      activeSignalCount: 0, matchedRules: [], evidence: [], evidenceTruncated: false,
      evaluatedAt: "2026-10-08T00:00:00Z",
    });
    render(await GovernanceRiskPage(search({ targetUserId: "no-signal" })));
    expect(mocks.loadAuthorizedRiskIntelligence).toHaveBeenCalledWith({
      access: { global: true, campusIds: [] }, targetUserId: "no-signal",
    });
    cleanup();
    render(await GovernanceRiskPage(search({ targetUserId: "no-signal", campusId: "A" })));
    expect(mocks.loadAuthorizedRiskIntelligence).toHaveBeenLastCalledWith({
      access: { global: true, campusIds: [] }, targetUserId: "no-signal", campusId: "A",
    });
  });

  it("unrelated capabilities and inactive/stale grants cannot open the page", async () => {
    actor([{ scope: "GLOBAL", campusId: null, permissionKeys: ["enforcement.read", "audit.read"] }]);
    await expect(GovernanceRiskPage(search())).rejects.toThrow("NOT_FOUND");
    actor([{ scope: "CAMPUS", campusId: "A", permissionKeys: ["risk.read"] }]);
    await expect(GovernanceRiskPage(search())).rejects.toThrow("NOT_FOUND");
    expect(mocks.loadAuthorizedRiskIntelligence).not.toHaveBeenCalled();
  });

  it("unknown/array/oversize query inputs fail closed; empty target does not query", async () => {
    actor([{ scope: "GLOBAL", campusId: null, permissionKeys: ["risk.read"] }]);
    for (const query of [
      { targetUserId: ["A", "B"] },
      { targetUserId: "A", campusId: ["A", "B"] },
      { targetUserId: "A", extra: "untrusted" },
      { targetUserId: "A".repeat(129) },
      { targetUserId: "A", campusId: "!" },
    ]) {
      const tree = render(await GovernanceRiskPage(search(query)));
      expect(screen.getByRole("alert").textContent).toContain("参数无效");
      tree.unmount();
    }
    render(await GovernanceRiskPage(search()));
    expect(screen.getByText(/输入目标用户 ID 开始查询/)).toBeTruthy();
    expect(mocks.loadAuthorizedRiskIntelligence).not.toHaveBeenCalled();
  });

  it("signal-only evidence does not surface untrusted raw note/sourceId fields", async () => {
    actor([{ scope: "GLOBAL", campusId: null, permissionKeys: ["risk.read"] }]);
    mocks.loadAuthorizedRiskIntelligence.mockResolvedValue({
      rulesetVersion: 1, scope: { kind: "ALL_SCOPES" }, attentionLevel: "REVIEW",
      activeSignalCount: 9, matchedRules: [], evidenceTruncated: true,
      evaluatedAt: "2026-10-08T00:00:00Z", evidence: [{
        signalId: "flag-1", kind: "MANUAL_FLAG", severity: "MEDIUM",
        campusId: "A", sourceType: "MANUAL",
        createdAt: "2026-10-08T00:00:00Z",
      }],
    });
    render(await GovernanceRiskPage(search({ targetUserId: "target" })));
    expect(screen.getByRole("region", { name: "风险信号证据" }).textContent).toContain("部分证据");
    expect(screen.queryByText("sourceId")).toBeNull();
    expect(screen.queryByText("note")).toBeNull();
    expect(screen.queryByRole("button", { name: /处置|处罚|限制/ })).toBeNull();
  });
});
