import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getServiceFormMeta, createService } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getServiceFormMeta: vi.fn(),
  createService: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/service-repository", () => ({
  getServiceFormMeta,
}));

vi.mock("@/actions/service", () => ({
  createService,
}));

vi.mock("@/components/service/service-form", () => ({
  ServiceForm: ({
    action,
    categories,
    submitLabel,
  }: {
    action: unknown;
    categories: Array<{ id: string; name: string }>;
    submitLabel: string;
  }) => (
    <div data-action={action === createService ? "matched" : "unmatched"}>
      <p>服务分类数量 {categories.length}</p>
      <p>{submitLabel}</p>
    </div>
  ),
}));

import NewServicePage from "@/app/services/new/page";

afterEach(() => {
  cleanup();
});

describe("NewServicePage", () => {
  it("renders the service publishing page", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getServiceFormMeta.mockResolvedValue({
      categories: [{ id: "service-category-1", name: "设计" }],
    });

    render(await NewServicePage());

    expect(screen.getByRole("heading", { name: "发布服务" })).toBeTruthy();
    expect(screen.getByText("服务分类数量 1")).toBeTruthy();
    expect(screen.getByText("立即发布")).toBeTruthy();
    expect(screen.getByText("服务分类数量 1").parentElement?.getAttribute("data-action")).toBe("matched");
  });
});
