import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireOperationsOverviewAdmin, loadSystemOverview } = vi.hoisted(() => ({
  requireOperationsOverviewAdmin: vi.fn(),
  loadSystemOverview: vi.fn(),
}));

vi.mock("@/lib/governance/operations-overview-access", () => ({
  requireOperationsOverviewAdmin,
}));

vi.mock("@/lib/governance/system-overview-service", () => ({
  loadSystemOverview,
}));

import GovernanceSystemPage from "@/app/governance/system/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GovernanceSystemPage（/governance/system，SO01-SO10 页面层）", () => {
  it("SO01：GLOBAL operations.overview → 渲染 release + 三依赖状态", async () => {
    requireOperationsOverviewAdmin.mockResolvedValue({ user: { id: "op-1" } });
    loadSystemOverview.mockResolvedValue({
      release: "abc1234",
      status: "ready",
      dependencies: { database: "ok", redis: "degraded", storage: "ok" },
    });

    render(await GovernanceSystemPage());

    expect(screen.getByRole("heading", { name: "系统状态" })).toBeTruthy();
    expect(screen.getByTestId("release-sha").textContent).toBe("abc1234");
    expect(screen.getByText("就绪")).toBeTruthy();
    expect(screen.getByText("降级")).toBeTruthy();
    expect(screen.getByText("数据库").textContent).toBeTruthy();
    expect(screen.getByText("Redis").textContent).toBeTruthy();
    expect(screen.getByText("对象存储").textContent).toBeTruthy();
  });

  it("SO02/SO03：非 GLOBAL operations.overview → 子树自守门 notFound（页面零数据查询）", async () => {
    requireOperationsOverviewAdmin.mockImplementation(() => {
      throw new Error("NOT_FOUND");
    });

    await expect(GovernanceSystemPage()).rejects.toThrow("NOT_FOUND");
    expect(loadSystemOverview).not.toHaveBeenCalled();
  });

  it("SO06/SO05/SO07：依赖降级/故障只渲染 canonical status enum（fail-soft 不 500）", async () => {
    requireOperationsOverviewAdmin.mockResolvedValue({ user: { id: "op-1" } });
    loadSystemOverview.mockResolvedValue({
      release: "dev",
      status: "not_ready",
      dependencies: { database: "failed", redis: "degraded", storage: "failed" },
    });

    render(await GovernanceSystemPage());

    expect(screen.getByText("未就绪")).toBeTruthy();
    expect(screen.getAllByText("故障").length).toBe(2);
    expect(screen.getByText("降级")).toBeTruthy();
  });

  it("SO08/SO09：页面结构性不含 secret 形态内容；不消费 metrics token", async () => {
    requireOperationsOverviewAdmin.mockResolvedValue({ user: { id: "op-1" } });
    loadSystemOverview.mockResolvedValue({
      release: "abc1234",
      status: "ready",
      dependencies: { database: "ok", redis: "ok", storage: "ok" },
    });

    const { container } = render(await GovernanceSystemPage());

    const text = container.textContent ?? "";
    for (const forbidden of [
      "postgres://",
      "redis://",
      "s3://",
      "METRICS_BEARER_TOKEN",
      "NEXTAUTH_SECRET",
      "access_key",
      "secret_key",
      "Error:",
      "at ",
      "127.0.0.1",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("SO10：页面为纯只读展示（零 form/零 button）", async () => {
    requireOperationsOverviewAdmin.mockResolvedValue({ user: { id: "op-1" } });
    loadSystemOverview.mockResolvedValue({
      release: "dev",
      status: "ready",
      dependencies: { database: "ok", redis: "ok", storage: "ok" },
    });

    const { container } = render(await GovernanceSystemPage());

    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });
});
