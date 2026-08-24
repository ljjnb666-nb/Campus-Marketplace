import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrandClaimDialog } from "@/components/errand/errand-claim-dialog";

const baseErrand = {
  id: "errand-1",
  title: "帮我取快递",
  reward: 8,
  pickupLocation: "东区快递站",
  deliveryLocation: "6 号宿舍楼下",
  deadline: "2026-08-22T18:00:00.000Z",
  needsAdvancePay: false,
};

type ClaimAction = (
  formData: FormData,
) => Promise<{ success?: boolean; message?: string; redirectTo?: string } | void>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function renderDialog(result?: { success?: boolean; message?: string; redirectTo?: string }) {
  const onOpenChange = vi.fn();
  const action = vi.fn<ClaimAction>();
  action.mockResolvedValue(result);
  vi.stubGlobal("location", { ...window.location, href: "" });
  render(
    <ErrandClaimDialog open onOpenChange={onOpenChange} action={action} errand={baseErrand} />,
  );
  return { onOpenChange, action };
}

describe("ErrandClaimDialog", () => {
  it("renders nothing when closed", () => {
    render(
      <ErrandClaimDialog
        open={false}
        onOpenChange={vi.fn()}
        action={vi.fn()}
        errand={baseErrand}
      />,
    );

    expect(screen.queryByText("确认接受该跑腿任务")).not.toBeInTheDocument();
  });

  it("shows the errand summary with route and deadline", () => {
    renderDialog();

    expect(screen.getByText("帮我取快递")).toBeInTheDocument();
    expect(screen.getByText("东区快递站")).toBeInTheDocument();
    expect(screen.getByText("6 号宿舍楼下")).toBeInTheDocument();
    expect(screen.queryByText(/需要垫付/)).not.toBeInTheDocument();
  });

  it("highlights advance payment requirements", () => {
    render(
      <ErrandClaimDialog
        open
        onOpenChange={vi.fn()}
        action={vi.fn()}
        errand={{ ...baseErrand, needsAdvancePay: true, advanceAmount: 25 }}
      />,
    );

    expect(screen.getByText(/需要垫付：¥25.00/)).toBeInTheDocument();
  });

  it("submits the errand id and shows success before redirecting", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { action } = renderDialog({ success: true });

    fireEvent.click(screen.getByRole("button", { name: "确认接单" }));

    await vi.advanceTimersByTimeAsync(0);
    expect(action).toHaveBeenCalled();
    const formData = action.mock.calls[0][0] as FormData;
    expect(formData.get("errandId")).toBe("errand-1");
    expect(await screen.findByText("接单成功！")).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(1300);
    expect(window.location.href).toBe("/my/orders?type=errand");
  });

  it("redirects to a custom target when provided", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderDialog({ success: true, redirectTo: "/rental-orders/1" });

    fireEvent.click(screen.getByRole("button", { name: "确认接单" }));
    expect(await screen.findByText("接单成功！")).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(1300);
    expect(window.location.href).toBe("/rental-orders/1");
  });

  it("shows the failure message when the claim loses the race", async () => {
    const { onOpenChange } = renderDialog({ success: false, message: "任务已被抢" });

    fireEvent.click(screen.getByRole("button", { name: "确认接单" }));

    expect(await screen.findByText("任务已被抢")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes via the secondary button", () => {
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "思考一下" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
