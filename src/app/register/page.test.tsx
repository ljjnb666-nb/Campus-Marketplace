import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { listActiveCampuses, getCurrentLegalDocuments } = vi.hoisted(() => ({
  listActiveCampuses: vi.fn(),
  getCurrentLegalDocuments: vi.fn(),
}));

vi.mock("@/repositories/user-repository", () => ({
  listActiveCampuses,
}));

vi.mock("@/repositories/legal-repository", () => ({
  getCurrentLegalDocuments,
}));

vi.mock("@/components/auth/register-form", () => ({
  RegisterForm: ({
    campuses,
  }: {
    campuses: Array<{ id: string; name: string; schoolName: string }>;
  }) => (
    <div>
      <p>校区数量 {campuses.length}</p>
      {campuses.map((campus) => (
        <p key={campus.id}>
          {campus.schoolName} {campus.name}
        </p>
      ))}
    </div>
  ),
}));

import RegisterPage from "@/app/register/page";

afterEach(() => {
  cleanup();
});

describe("RegisterPage", () => {
  it("renders campuses into the register form", async () => {
    listActiveCampuses.mockResolvedValue([
      { id: "campus-1", schoolName: "示例大学", name: "主校区" },
      { id: "campus-2", schoolName: "示例大学", name: "东校区" },
    ]);
    getCurrentLegalDocuments.mockResolvedValue([
      {
        type: "TERMS_OF_SERVICE",
        slug: "terms",
        id: "doc-terms",
        version: 1,
        title: "校园集市用户服务协议",
        effectiveAt: new Date("2026-09-01T00:00:00Z"),
      },
    ]);

    render(await RegisterPage());

    expect(screen.getByText("创建账号")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "注册校园集市" })).toBeTruthy();
    expect(screen.getByText("校区数量 2")).toBeTruthy();
    expect(screen.getByText("示例大学 主校区")).toBeTruthy();
    expect(screen.getByText("示例大学 东校区")).toBeTruthy();
    // 注册表单接收当前 required 协议文档（Phase 5 显式同意）
    expect(getCurrentLegalDocuments).toHaveBeenCalled();
  });
});
