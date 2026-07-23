import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendMessageForm } from "@/components/conversation/send-message-form";

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

describe("SendMessageForm", () => {
  it("renders conversation id and message input", () => {
    render(
      <SendMessageForm
        action={async () => ({ success: false, message: "" })}
        conversationId="conversation-1"
      />,
    );

    expect(screen.getByDisplayValue("conversation-1")).toHaveAttribute("type", "hidden");
    expect(screen.getByPlaceholderText("输入你想发送的内容")).toBeTruthy();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeTruthy();
  });

  it("shows the action error message from server state", () => {
    mockUseActionState.mockReturnValue([{ success: false, message: "消息内容不能为空" }, vi.fn()]);

    render(
      <SendMessageForm
        action={async () => ({ success: false, message: "" })}
        conversationId="conversation-1"
      />,
    );

    expect(screen.getByText("消息内容不能为空")).toBeTruthy();
  });

  it("resets and redirects after a successful action state", () => {
    const resetSpy = vi.spyOn(HTMLFormElement.prototype, "reset");

    mockUseActionState.mockReturnValue([
      { success: true, message: "发送成功", redirectTo: "/messages/conversation-1" },
      vi.fn(),
    ]);

    render(
      <SendMessageForm
        action={async () => ({ success: false, message: "" })}
        conversationId="conversation-1"
      />,
    );

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/messages/conversation-1");
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    resetSpy.mockRestore();
  });
});
