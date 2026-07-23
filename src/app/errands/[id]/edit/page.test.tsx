import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getErrandForEdit, getErrandFormMeta, updateErrand } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getErrandForEdit: vi.fn(),
  getErrandFormMeta: vi.fn(),
  updateErrand: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/errand-repository", () => ({
  getErrandForEdit,
  getErrandFormMeta,
}));

vi.mock("@/actions/errand", () => ({
  updateErrand,
}));

vi.mock("@/components/errand/errand-form", () => ({
  ErrandForm: ({
    action,
    categories,
    submitLabel,
    initialValues,
  }: {
    action: unknown;
    categories: Array<{ id: string; name: string }>;
    submitLabel: string;
    initialValues: { errandId: string; title: string };
  }) => (
    <div data-action={action === updateErrand ? "matched" : "unmatched"}>
      <p>任务分类数量 {categories.length}</p>
      <p>{submitLabel}</p>
      <p>{initialValues.errandId}</p>
      <p>{initialValues.title}</p>
    </div>
  ),
}));

import EditErrandPage from "@/app/errands/[id]/edit/page";

afterEach(() => {
  cleanup();
});

describe("EditErrandPage", () => {
  it("renders editable errand defaults", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getErrandFormMeta.mockResolvedValue({
      categories: [{ id: "errand-category-1", name: "代取快递" }],
    });
    getErrandForEdit.mockResolvedValue({
      id: "errand-1",
      title: "代取快递",
      description: "下午送到宿舍",
      categoryId: "errand-category-1",
      reward: 6,
      pickupLocation: "快递站",
      deliveryLocation: "宿舍楼",
      deadline: new Date("2026-07-20T09:00:00.000Z"),
      contactNote: "先电话联系",
      needsAdvancePay: true,
      advanceAmount: 20,
    });

    render(
      await EditErrandPage({
        params: Promise.resolve({ id: "errand-1" }),
      }),
    );

    expect(screen.getByRole("heading", { name: "编辑跑腿任务" })).toBeTruthy();
    expect(screen.getByText("任务分类数量 1")).toBeTruthy();
    expect(screen.getByText("保存修改")).toBeTruthy();
    expect(screen.getByText("errand-1")).toBeTruthy();
    expect(screen.getByText("代取快递")).toBeTruthy();
    expect(screen.getByText("任务分类数量 1").parentElement?.getAttribute("data-action")).toBe("matched");
  });
});
