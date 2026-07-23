import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getServiceForEdit, updateService } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getServiceForEdit: vi.fn(),
  updateService: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/service-repository", () => ({
  getServiceForEdit,
}));

vi.mock("@/actions/service", () => ({
  updateService,
}));

vi.mock("@/components/service/service-form", () => ({
  ServiceForm: ({
    action,
    categories,
    submitLabel,
    initialValues,
  }: {
    action: unknown;
    categories: Array<{ id: string; name: string }>;
    submitLabel: string;
    initialValues: { serviceId: string; title: string };
  }) => (
    <div data-action={action === updateService ? "matched" : "unmatched"}>
      <p>服务分类数量 {categories.length}</p>
      <p>{submitLabel}</p>
      <p>{initialValues.serviceId}</p>
      <p>{initialValues.title}</p>
    </div>
  ),
}));

import EditServicePage from "@/app/services/[id]/edit/page";

afterEach(() => {
  cleanup();
});

describe("EditServicePage", () => {
  it("renders editable service defaults", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getServiceForEdit.mockResolvedValue({
      service: {
        id: "service-1",
        title: "PPT 美化",
        description: "答辩优化",
        categoryId: "service-category-1",
        price: 88,
        pricingUnit: "PER_ORDER",
        locationText: "线上",
        availableSchedule: "周末",
        coverImageUrl: "/uploads/services/cover.jpg",
      },
      categories: [{ id: "service-category-1", name: "设计" }],
    });

    render(
      await EditServicePage({
        params: Promise.resolve({ id: "service-1" }),
      }),
    );

    expect(screen.getByRole("heading", { name: "编辑服务" })).toBeTruthy();
    expect(screen.getByText("服务分类数量 1")).toBeTruthy();
    expect(screen.getByText("保存修改")).toBeTruthy();
    expect(screen.getByText("service-1")).toBeTruthy();
    expect(screen.getByText("PPT 美化")).toBeTruthy();
    expect(screen.getByText("服务分类数量 1").parentElement?.getAttribute("data-action")).toBe("matched");
  });
});
