import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getErrandFormMeta, createErrand } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getErrandFormMeta: vi.fn(),
  createErrand: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/errand-repository", () => ({
  getErrandFormMeta,
}));

vi.mock("@/actions/errand", () => ({
  createErrand,
}));

vi.mock("@/components/errand/errand-form", () => ({
  ErrandForm: ({
    action,
    categories,
    submitLabel,
  }: {
    action: unknown;
    categories: Array<{ id: string; name: string }>;
    submitLabel: string;
  }) => (
    <div data-action={action === createErrand ? "matched" : "unmatched"}>
      <p>任务分类数量 {categories.length}</p>
      <p>{submitLabel}</p>
    </div>
  ),
}));

import NewErrandPage from "@/app/errands/new/page";

afterEach(() => {
  cleanup();
});

describe("NewErrandPage", () => {
  it("renders the errand publishing page", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getErrandFormMeta.mockResolvedValue({
      categories: [{ id: "errand-category-1", name: "代取快递" }],
    });

    render(await NewErrandPage());

    expect(screen.getByRole("heading", { name: "发布跑腿任务" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "我的任务" }).getAttribute("href")).toBe("/my/errands");
    expect(screen.getByText("任务分类数量 1")).toBeTruthy();
    expect(screen.getByText("发布任务")).toBeTruthy();
    expect(screen.getByText("任务分类数量 1").parentElement?.getAttribute("data-action")).toBe("matched");
  });
});
