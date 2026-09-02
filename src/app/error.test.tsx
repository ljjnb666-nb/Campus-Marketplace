import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import RootError from "@/app/error";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderError(reset = vi.fn()) {
  return {
    reset,
    ...render(
      <RootError error={new Error("页面加载失败")} reset={reset} />,
    ),
  };
}

describe("RootError", () => {
  it("renders the error message, retry button and home link", () => {
    renderError();

    expect(screen.getByRole("heading", { name: "出错了" })).toBeTruthy();
    expect(screen.getByText(/页面加载失败，请稍后重试/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "回到首页" }).getAttribute("href")).toBe("/");
  });

  it("有 digest 时展示安全参考编号；绝不展示 stack/消息本体", () => {
    const error = Object.assign(new Error("secret internal detail from db"), {
      digest: "abc123digest",
    });
    render(<RootError error={error} reset={vi.fn()} />);

    expect(screen.getByText(/abc123digest/)).toBeTruthy();
    // ERROR_LEAKAGE_TEST（UI 侧）：内部异常细节不进入用户可见 UI
    expect(screen.queryByText(/secret internal detail/)).toBeNull();
    expect(document.body.textContent).not.toContain("at Object");
  });

  it("无 digest 时不渲染参考编号区块", () => {
    renderError();

    expect(screen.queryByText(/参考编号/)).toBeNull();
  });

  it("invokes reset when the retry button is clicked and logs the error", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { reset } = renderError();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(reset).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
