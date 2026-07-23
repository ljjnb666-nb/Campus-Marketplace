import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireAdmin,
  getAdminModerationKeywords,
  upsertModerationKeyword,
  toggleModerationKeywordStatus,
} = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getAdminModerationKeywords: vi.fn(),
  upsertModerationKeyword: vi.fn(),
  toggleModerationKeywordStatus: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  requireAdmin,
}));

vi.mock("@/repositories/admin-repository", () => ({
  getAdminModerationKeywords,
}));

vi.mock("@/actions/admin", () => ({
  upsertModerationKeyword,
  toggleModerationKeywordStatus,
}));

import AdminKeywordsPage from "@/app/admin/keywords/page";

afterEach(() => {
  cleanup();
});

describe("AdminKeywordsPage", () => {
  it("renders the empty state when there are no keywords", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getAdminModerationKeywords.mockResolvedValue([]);

    render(await AdminKeywordsPage());

    expect(screen.getByRole("heading", { name: "违禁关键词管理" })).toBeTruthy();
    expect(screen.getByText("当前还没有关键词规则。")).toBeTruthy();
  });

  it("renders keywords with edit and toggle actions", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getAdminModerationKeywords.mockResolvedValue([
      {
        id: "keyword-1",
        keyword: "代考",
        targetType: "GLOBAL",
        isEnabled: true,
      },
    ]);

    render(await AdminKeywordsPage());

    expect(screen.getByDisplayValue("代考")).toBeTruthy();
    expect(screen.getAllByDisplayValue("全局")[1]).toBeTruthy();
    expect(screen.getAllByDisplayValue("keyword-1")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "停用" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "创建关键词" })).toBeTruthy();
  });
});
