import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAuditReader, loadAuthorizedAuditPage, notFound } = vi.hoisted(() => ({
  requireAuditReader: vi.fn(),
  loadAuthorizedAuditPage: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/lib/audit/audit-access", () => ({
  requireAuditReader,
}));

vi.mock("@/lib/audit/audit-read-model", () => ({
  loadAuthorizedAuditPage,
}));

vi.mock("next/navigation", () => ({
  notFound,
}));

import GovernanceAuditPage from "@/app/governance/audit/page";

const READER = {
  user: { id: "u1", name: "审计员" },
  context: { userId: "u1" },
  access: { global: true, campusIds: [] },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "log-1",
    action: "SUSPEND_USER",
    targetType: "USER",
    targetId: "target-1",
    result: "SUCCESS",
    createdAt: new Date("2026-09-15T08:00:00.000Z").toISOString(),
    scope: "NO_CAMPUS_SCOPE_RECORDED",
    campusId: null,
    campusName: null,
    actor: { id: "actor-1", displayName: "审计员甲" },
    metadata: [{ key: "reasonCode", label: "原因码", value: "FRAUD_CONFIRMED" }],
    ...overrides,
  };
}

describe("GovernanceAuditPage（7D 只读审计面）", () => {
  it("渲染队列行：null campus 显示 无校区归属记录（非 全局操作）；metadata 仅 label/value 条目", async () => {
    requireAuditReader.mockResolvedValue(READER);
    loadAuthorizedAuditPage.mockResolvedValue({
      items: [row()],
      nextCursor: null,
    });

    render(await GovernanceAuditPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("SUSPEND_USER")).toBeTruthy();
    expect(screen.getByText("无校区归属记录")).toBeTruthy();
    expect(screen.queryByText("全局操作")).toBeNull();
    expect(screen.getByText(/原因码：/)).toBeTruthy();
    expect(screen.getByText("FRAUD_CONFIRMED")).toBeTruthy();
    // detail / raw JSON 永不出现
    expect(screen.queryByText(/detail/)).toBeNull();
    expect(loadAuthorizedAuditPage).toHaveBeenCalledWith(
      expect.objectContaining({ access: READER.access, limit: 25 }),
    );
  });

  it("CAMPUS 行显示校区名", async () => {
    requireAuditReader.mockResolvedValue(READER);
    loadAuthorizedAuditPage.mockResolvedValue({
      items: [row({ scope: "CAMPUS", campusId: "A", campusName: "主校区" })],
      nextCursor: null,
    });

    render(await GovernanceAuditPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("校区：主校区")).toBeTruthy();
  });

  it("畸形 cursor → 安全失败态（不回退首页、不渲染数据）", async () => {
    requireAuditReader.mockResolvedValue(READER);
    loadAuthorizedAuditPage.mockResolvedValue({ items: [], nextCursor: null });

    render(await GovernanceAuditPage({ searchParams: Promise.resolve({ cursor: "!!!" }) }));

    expect(screen.getByText(/分页链接无效/)).toBeTruthy();
    expect(loadAuthorizedAuditPage).not.toHaveBeenCalled();
  });

  it("无效筛选参数 → 安全失败态", async () => {
    requireAuditReader.mockResolvedValue(READER);
    loadAuthorizedAuditPage.mockResolvedValue({ items: [], nextCursor: null });

    render(await GovernanceAuditPage({ searchParams: Promise.resolve({ from: "2026/09/01" }) }));

    expect(screen.getByText(/筛选参数无效/)).toBeTruthy();
    expect(loadAuthorizedAuditPage).not.toHaveBeenCalled();
  });

  it("空队列 → 空态卡片", async () => {
    requireAuditReader.mockResolvedValue(READER);
    loadAuthorizedAuditPage.mockResolvedValue({ items: [], nextCursor: null });

    render(await GovernanceAuditPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText(/没有审计记录/)).toBeTruthy();
  });

  it("无 audit.read → notFound（页面自守）", async () => {
    requireAuditReader.mockImplementation(() => {
      notFound();
    });

    await expect(
      GovernanceAuditPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
    expect(loadAuthorizedAuditPage).not.toHaveBeenCalled();
  });
});
