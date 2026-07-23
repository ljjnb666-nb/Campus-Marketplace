import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceForm } from "@/components/service/service-form";

const { mockPush, mockRefresh } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}));

beforeEach(() => {
  mockPush.mockReset();
  mockRefresh.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ServiceForm", () => {
  it("renders publishing defaults including category choices and image inputs", () => {
    const { container } = render(
      <ServiceForm
        action={async () => ({ success: false, message: "" })}
        categories={[{ id: "cat-1", name: "摄影约拍", slug: "photo" }]}
        submitLabel="发布服务"
      />,
    );

    expect(screen.getByRole("option", { name: "请选择服务分类" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "摄影约拍" })).toBeTruthy();
    expect(screen.getByLabelText("计费方式")).toHaveValue("PER_SESSION");
    expect(container.querySelector('input[type="file"]')).toBeInTheDocument();
  });

  it("renders editing defaults and the hidden service id field", () => {
    render(
      <ServiceForm
        action={async () => ({ success: false, message: "" })}
        categories={[{ id: "cat-1", name: "摄影约拍", slug: "photo" }]}
        submitLabel="保存服务"
        initialValues={{
          serviceId: "service-1",
          title: "毕业照约拍",
          description: "支持双人和宿舍合影",
          categoryId: "cat-1",
          price: "88",
          pricingUnit: "PER_HOUR",
          locationText: "校内草坪",
          availableSchedule: "周末全天",
          coverImageUrl: "/uploads/services/photo.jpg",
        }}
      />,
    );

    expect(screen.getByDisplayValue("service-1")).toHaveAttribute("type", "hidden");
    expect(screen.getByDisplayValue("毕业照约拍")).toBeTruthy();
    expect(screen.getByDisplayValue("支持双人和宿舍合影")).toBeTruthy();
    expect(screen.getByLabelText("服务分类")).toHaveValue("cat-1");
    expect(screen.getByDisplayValue("88")).toBeTruthy();
    expect(screen.getByLabelText("计费方式")).toHaveValue("PER_HOUR");
    expect(screen.getByDisplayValue("校内草坪")).toBeTruthy();
    expect(screen.getByDisplayValue("周末全天")).toBeTruthy();
  });

  it("shows the action error message from server state", async () => {
    const mockAction = vi.fn().mockResolvedValue({ success: false, message: "服务标题重复" });

    const { container } = render(
      <ServiceForm
        action={mockAction}
        categories={[{ id: "cat-1", name: "摄影约拍", slug: "photo" }]}
        submitLabel="发布服务"
        initialValues={{
          title: "测试标题",
          description: "测试描述信息足够长",
          categoryId: "cat-1",
          price: "100",
          locationText: "线下",
        }}
      />,
    );

    const form = container.querySelector("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText("服务标题重复")).toBeTruthy();
    });
  });

  it("redirects after a successful action state", async () => {
    const mockAction = vi.fn().mockResolvedValue({
      success: true,
      message: "发布成功",
      redirectTo: "/services/service-1",
    });

    const { container } = render(
      <ServiceForm
        action={mockAction}
        categories={[{ id: "cat-1", name: "摄影约拍", slug: "photo" }]}
        submitLabel="发布服务"
        initialValues={{
          title: "测试标题",
          description: "测试描述信息足够长",
          categoryId: "cat-1",
          price: "100",
          locationText: "线下",
        }}
      />,
    );

    const form = container.querySelector("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/services/service-1");
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
  });
});
