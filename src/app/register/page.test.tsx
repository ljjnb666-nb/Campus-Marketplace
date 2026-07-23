import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    campus: {
      findMany,
    },
  },
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
    findMany.mockResolvedValue([
      { id: "campus-1", schoolName: "示例大学", name: "主校区" },
      { id: "campus-2", schoolName: "示例大学", name: "东校区" },
    ]);

    render(await RegisterPage());

    expect(screen.getByText("创建账号")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "注册校园集市" })).toBeTruthy();
    expect(screen.getByText("校区数量 2")).toBeTruthy();
    expect(screen.getByText("示例大学 主校区")).toBeTruthy();
    expect(screen.getByText("示例大学 东校区")).toBeTruthy();
  });
});
