import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireEnforcementReader, loadAuthorizedEnforcementQueue, notFound } = vi.hoisted(() => ({
  requireEnforcementReader: vi.fn(),
  loadAuthorizedEnforcementQueue: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/lib/enforcement/enforcement-read-access", () => ({
  requireEnforcementReader,
}));

vi.mock("@/lib/enforcement/enforcement-read-model", () => ({
  loadAuthorizedEnforcementQueue,
}));

vi.mock("next/navigation", () => ({
  notFound,
}));

import GovernanceEnforcementPage from "@/app/governance/enforcement/page";

const READER = {
  user: { id: "u1", name: "执法读者" },
  context: { userId: "u1" },
  access: { global: true, campusIds: [] },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function item(overrides: Record<string, unknown> = {}) {
  return {
    seq: "1000000007",
    type: "ACCOUNT_SUSPEND",
    scope: "GLOBAL",
    campusId: null,
    campusName: null,
    reasonCode: "FRAUD_CONFIRMED",
    sourceType: "REPORT",
    resultState: "USER:SUSPENDED",
    provenanceComplete: true,
    legacyEpoch: false,
    createdAt: new Date("2026-09-15T08:00:00.000Z").toISOString(),
    actor: { id: "actor-1", displayName: "执法员" },
    target: { id: "target-1", displayName: "目标用户" },
    ...overrides,
  };
}

describe("GovernanceEnforcementPage（7D 只读执法面）", () => {
  it("渲染队列行：seq 十进制串、scope 展示、来源类型；无 note/sourceId", async () => {
    requireEnforcementReader.mockResolvedValue(READER);
    loadAuthorizedEnforcementQueue.mockResolvedValue({
      items: [item()],
      nextCursor: null,
    });

    render(await GovernanceEnforcementPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText(/#1000000007/)).toBeTruthy();
    expect(screen.getAllByText("账号停用").length).toBeGreaterThan(0);
    expect(screen.getByText("全局")).toBeTruthy();
    expect(screen.getByText(/来源 REPORT/)).toBeTruthy();
    expect(screen.getByText(/目标：目标用户/)).toBeTruthy();
    expect(screen.queryByText(/operator internal note/)).toBeNull();
  });

  it("scope 不一致行 → 「范围记录不一致」fail-closed fallback；徽标正确", async () => {
    requireEnforcementReader.mockResolvedValue(READER);
    loadAuthorizedEnforcementQueue.mockResolvedValue({
      items: [
        item({
          seq: "999999999",
          scope: "SCOPE_INCONSISTENT",
          legacyEpoch: true,
          provenanceComplete: false,
        }),
      ],
      nextCursor: null,
    });

    render(await GovernanceEnforcementPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("范围记录不一致")).toBeTruthy();
    expect(screen.getByText("迁移前记录")).toBeTruthy();
    expect(screen.getByText("溯源不完整")).toBeTruthy();
  });

  it("畸形 cursor → 安全失败态", async () => {
    requireEnforcementReader.mockResolvedValue(READER);
    loadAuthorizedEnforcementQueue.mockResolvedValue({ items: [], nextCursor: null });

    render(await GovernanceEnforcementPage({ searchParams: Promise.resolve({ cursor: "!!!", limit: "25" }) }));

    expect(screen.getByText(/分页链接无效/)).toBeTruthy();
    expect(loadAuthorizedEnforcementQueue).not.toHaveBeenCalled();
  });

  it("未授权 type 筛选值 → 筛选参数无效", async () => {
    requireEnforcementReader.mockResolvedValue(READER);
    loadAuthorizedEnforcementQueue.mockResolvedValue({ items: [], nextCursor: null });

    render(await GovernanceEnforcementPage({ searchParams: Promise.resolve({ type: "NOT_A_TYPE" }) }));

    expect(screen.getByText(/筛选参数无效/)).toBeTruthy();
    expect(loadAuthorizedEnforcementQueue).not.toHaveBeenCalled();
  });

  it("无 enforcement.read → notFound（页面自守）", async () => {
    requireEnforcementReader.mockImplementation(() => {
      notFound();
    });

    await expect(
      GovernanceEnforcementPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });
});
