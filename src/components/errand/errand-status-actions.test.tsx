import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrandStatusActions } from "@/components/errand/errand-status-actions";

vi.mock("@/actions/errand", () => ({
  updateErrandStatus: vi.fn(),
}));

describe("ErrandStatusActions", () => {
  it("renders one form per provided errand action", () => {
    const { container } = render(
      <ErrandStatusActions
        errandId="errand-1"
        actions={[
          { status: "IN_PROGRESS", label: "开始处理" },
          { status: "COMPLETED", label: "完成任务" },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "开始处理" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "完成任务" })).toBeTruthy();
    expect(container.querySelectorAll("form")).toHaveLength(2);
    expect(container.querySelectorAll('input[name="errandId"][value="errand-1"]')).toHaveLength(2);
    expect(container.querySelector('input[name="status"][value="IN_PROGRESS"]')).toBeTruthy();
    expect(container.querySelector('input[name="status"][value="COMPLETED"]')).toBeTruthy();
  });
});
