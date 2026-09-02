import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import GlobalError from "@/app/global-error";

/**
 * Phase 4 TASK 12：全局错误边界（root layout 级故障最后防线）。
 * ERROR_LEAKAGE_TEST：UI 只含通用提示 + digest 参考编号 + 重试；
 * stack / 原始异常绝不进入用户可见内容。
 */
describe("GlobalError", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("渲染通用错误 UI + 重试按钮 + digest 参考编号", () => {
    const error = Object.assign(new Error("框架级故障：postgresql://u:topsecret@db/x"), {
      digest: "glob-err-42",
    });
    const reset = vi.fn();

    render(<GlobalError error={error} reset={reset} />);

    expect(screen.getByRole("heading", { name: "应用出现严重错误" })).toBeTruthy();
    expect(screen.getByText(/glob-err-42/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(reset).toHaveBeenCalledTimes(1);

    // 泄漏断言：原始异常消息（含连接串）不出现在任何用户可见文本
    expect(document.body.textContent).not.toContain("topsecret");
    expect(document.body.textContent).not.toContain("框架级故障");
  });

  it("无 digest 时不渲染参考编号", () => {
    render(<GlobalError error={new Error("boom")} reset={vi.fn()} />);

    expect(screen.queryByText(/参考编号/)).toBeNull();
  });
});
