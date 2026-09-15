import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireEnforcementReader,
  hasVisibleTargetAnchor,
  loadTargetEnforcementHistory,
  loadTargetRiskStateSummary,
  hydrateSafeIdentities,
  notFound,
} = vi.hoisted(() => ({
  requireEnforcementReader: vi.fn(),
  hasVisibleTargetAnchor: vi.fn(),
  loadTargetEnforcementHistory: vi.fn(),
  loadTargetRiskStateSummary: vi.fn(),
  hydrateSafeIdentities: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/lib/enforcement/enforcement-read-access", () => ({
  requireEnforcementReader,
}));

vi.mock("@/lib/enforcement/enforcement-read-model", () => ({
  hasVisibleTargetAnchor,
  loadTargetEnforcementHistory,
  loadTargetRiskStateSummary,
}));

vi.mock("@/lib/governance/safe-identity", () => ({
  hydrateSafeIdentities,
}));

vi.mock("next/navigation", () => ({
  notFound,
}));

import GovernanceEnforcementTargetPage from "@/app/governance/enforcement/targets/[targetId]/page";

const READER = {
  user: { id: "u1", name: "执法读者" },
  context: { userId: "u1" },
  access: { global: true, campusIds: [] },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage(targetId = "target-1") {
  return GovernanceEnforcementTargetPage({
    params: Promise.resolve({ targetId }),
    searchParams: Promise.resolve({}),
  });
}

describe("GovernanceEnforcementTargetPage（R5 存在性权威 + bounded 历史）", () => {
  it("有 anchor → 渲染目标身份 + RiskState summary + 因果历史", async () => {
    requireEnforcementReader.mockResolvedValue(READER);
    hasVisibleTargetAnchor.mockResolvedValue(true);
    hydrateSafeIdentities.mockResolvedValue(
      new Map([["target-1", { id: "target-1", displayName: "目标用户" }]]),
    );
    loadTargetEnforcementHistory.mockResolvedValue({
      items: [
        {
          seq: "1000000001",
          type: "MARKETPLACE_RESTRICT",
          scope: "GLOBAL",
          campusId: null,
          campusName: null,
          reasonCode: "FRAUD_CONFIRMED",
          sourceType: "REPORT",
          resultState: "RISK_STATE:RESTRICTED",
          provenanceComplete: true,
          legacyEpoch: false,
          createdAt: new Date("2026-09-15T08:00:00.000Z").toISOString(),
          actor: { id: "actor-1", displayName: "执法员" },
          target: { id: "target-1", displayName: "目标用户" },
        },
      ],
      nextCursor: null,
    });
    loadTargetRiskStateSummary.mockResolvedValue([
      {
        scopeKey: "GLOBAL",
        campusId: null,
        campusName: null,
        state: "RESTRICTED",
        reasonCode: "FRAUD_CONFIRMED",
        updatedBy: { id: "actor-1", displayName: "执法员" },
        updatedAt: new Date("2026-09-15T09:00:00.000Z").toISOString(),
      },
    ]);

    render(await renderPage());

    // anchor 查询先于身份水合（R5 顺序）
    expect(hasVisibleTargetAnchor).toHaveBeenCalledWith({
      access: READER.access,
      targetId: "target-1",
    });
    expect(hydrateSafeIdentities).toHaveBeenCalledAfter(hasVisibleTargetAnchor as unknown as never);

    expect(screen.getByText(/目标执法历史：目标用户/)).toBeTruthy();
    expect(screen.getByText("受限")).toBeTruthy();
    expect(screen.getByText("#1000000001")).toBeTruthy();
    expect(screen.getByText("集市限制")).toBeTruthy();
  });

  it("零 anchor → notFound（不水合身份、不渲染空详情页）", async () => {
    requireEnforcementReader.mockResolvedValue(READER);
    hasVisibleTargetAnchor.mockResolvedValue(false);

    await expect(renderPage()).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
    expect(hydrateSafeIdentities).not.toHaveBeenCalled();
    expect(loadTargetEnforcementHistory).not.toHaveBeenCalled();
  });

  it("注销/缺失目标 → 统一隐私 fallback 展示", async () => {
    requireEnforcementReader.mockResolvedValue(READER);
    hasVisibleTargetAnchor.mockResolvedValue(true);
    hydrateSafeIdentities.mockResolvedValue(
      new Map([["target-1", { id: "target-1", displayName: "已注销用户" }]]),
    );
    loadTargetEnforcementHistory.mockResolvedValue({ items: [], nextCursor: null });
    loadTargetRiskStateSummary.mockResolvedValue([]);

    render(await renderPage());

    expect(screen.getByText(/目标执法历史：已注销用户/)).toBeTruthy();
  });

  it("畸形 cursor → 安全失败态（历史区），RiskState summary 仍渲染", async () => {
    requireEnforcementReader.mockResolvedValue(READER);
    hasVisibleTargetAnchor.mockResolvedValue(true);
    hydrateSafeIdentities.mockResolvedValue(
      new Map([["target-1", { id: "target-1", displayName: "目标用户" }]]),
    );
    loadTargetEnforcementHistory.mockResolvedValue({ items: [], nextCursor: null });
    loadTargetRiskStateSummary.mockResolvedValue([]);

    render(
      await GovernanceEnforcementTargetPage({
        params: Promise.resolve({ targetId: "target-1" }),
        searchParams: Promise.resolve({ cursor: "!!!" }),
      }),
    );

    expect(screen.getByText(/分页链接无效/)).toBeTruthy();
    expect(loadTargetEnforcementHistory).not.toHaveBeenCalled();
    expect(loadTargetRiskStateSummary).toHaveBeenCalled();
  });

  it("无 enforcement.read → notFound", async () => {
    requireEnforcementReader.mockImplementation(() => {
      notFound();
    });

    await expect(renderPage()).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
    expect(hasVisibleTargetAnchor).not.toHaveBeenCalled();
  });
});
