import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorState } from "@/components/ui/error-state";
import { FilterBar } from "@/components/ui/filter-bar";

afterEach(cleanup);

describe("ErrorState", () => {
  it("renders default copy without a retry button", () => {
    render(<ErrorState />);

    expect(screen.getByText("出错了，无法加载数据")).toBeInTheDocument();
    expect(
      screen.getByText("网络请求失败或服务器异常，请检查网络连接后重试。"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders custom copy and triggers the retry handler", () => {
    const onRetry = vi.fn();
    render(<ErrorState title="加载失败" description="请稍后重试" onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "重新尝试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("FilterBar", () => {
  it("wraps children in the filter container", () => {
    render(
      <FilterBar>
        <span>筛选项</span>
      </FilterBar>,
    );

    expect(screen.getByText("筛选项")).toBeInTheDocument();
  });
});
