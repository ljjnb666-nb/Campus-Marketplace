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

  it("invokes reset when the retry button is clicked and logs the error", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { reset } = renderError();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(reset).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
