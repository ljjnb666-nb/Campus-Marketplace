import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrandForm } from "@/components/errand/errand-form";

const { mockPush, mockRefresh, mockUseActionState } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockUseActionState: vi.fn(),
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");

  return {
    ...actual,
    useActionState: mockUseActionState,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}));

beforeEach(() => {
  mockPush.mockReset();
  mockRefresh.mockReset();
  mockUseActionState.mockReset();
  mockUseActionState.mockReturnValue([{ success: false, message: "" }, vi.fn()]);
});

afterEach(() => {
  cleanup();
});

describe("ErrandForm", () => {
  it("renders publishing defaults for category and advance payment fields", () => {
    render(
      <ErrandForm
        action={async () => ({ success: false, message: "" })}
        categories={[{ id: "cat-1", name: "代取快递" }]}
        submitLabel="发布任务"
      />,
    );

    expect(screen.getByRole("option", { name: "请选择任务分类" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "代取快递" })).toBeTruthy();
    expect(screen.getByLabelText("是否需要垫付")).toHaveValue("false");
    expect(screen.getByPlaceholderText("例如：到了给我发消息")).toBeTruthy();
  });

  it("renders editing defaults and the hidden errand id field", () => {
    render(
      <ErrandForm
        action={async () => ({ success: false, message: "" })}
        categories={[{ id: "cat-1", name: "代取快递" }]}
        submitLabel="保存任务"
        initialValues={{
          errandId: "errand-1",
          title: "帮取快递",
          description: "两件小包裹，今晚 9 点前送到",
          categoryId: "cat-1",
          reward: "6",
          pickupLocation: "东区快递站",
          deliveryLocation: "3 号宿舍楼 402",
          deadline: "2026-07-18T21:00",
          contactNote: "到楼下联系我",
          needsAdvancePay: true,
          advanceAmount: "18",
        }}
      />,
    );

    expect(screen.getByDisplayValue("errand-1")).toHaveAttribute("type", "hidden");
    expect(screen.getByDisplayValue("帮取快递")).toBeTruthy();
    expect(screen.getByDisplayValue("两件小包裹，今晚 9 点前送到")).toBeTruthy();
    expect(screen.getByLabelText("任务分类")).toHaveValue("cat-1");
    expect(screen.getByDisplayValue("6")).toBeTruthy();
    expect(screen.getByDisplayValue("东区快递站")).toBeTruthy();
    expect(screen.getByDisplayValue("3 号宿舍楼 402")).toBeTruthy();
    expect(screen.getByDisplayValue("2026-07-18T21:00")).toBeTruthy();
    expect(screen.getByDisplayValue("到楼下联系我")).toBeTruthy();
    expect(screen.getByLabelText("是否需要垫付")).toHaveValue("true");
    expect(screen.getByDisplayValue("18")).toBeTruthy();
  });

  it("shows the action error message from server state", () => {
    mockUseActionState.mockReturnValue([{ success: false, message: "任务已结束，无法修改" }, vi.fn()]);

    render(
      <ErrandForm
        action={async () => ({ success: false, message: "" })}
        categories={[{ id: "cat-1", name: "代取快递" }]}
        submitLabel="发布任务"
      />,
    );

    expect(screen.getByText("任务已结束，无法修改")).toBeTruthy();
  });

  it("redirects after a successful action state", () => {
    mockUseActionState.mockReturnValue([
      { success: true, message: "发布成功", redirectTo: "/errands/errand-1" },
      vi.fn(),
    ]);

    render(
      <ErrandForm
        action={async () => ({ success: false, message: "" })}
        categories={[{ id: "cat-1", name: "代取快递" }]}
        submitLabel="发布任务"
      />,
    );

    expect(mockPush).toHaveBeenCalledWith("/errands/errand-1");
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
