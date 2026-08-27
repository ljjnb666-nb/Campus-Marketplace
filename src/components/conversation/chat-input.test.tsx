import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { sendMessage } = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock("@/actions/conversation", () => ({
  sendMessage,
}));

import { ChatInput } from "@/components/conversation/chat-input";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function contentField() {
  const el = document.querySelector('textarea[name="content"]');
  if (!el) throw new Error("content field not found");
  return el as HTMLTextAreaElement;
}

describe("ChatInput", () => {
  it("disables the composer and shows a hint when blocked", () => {
    render(
      <ChatInput conversationId="c1" disabled disabledHint="对方对你设置了消息屏蔽" />,
    );

    expect(contentField()).toBeDisabled();
    expect(screen.getByText("对方对你设置了消息屏蔽")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("无法在此发送消息")).toBeInTheDocument();
  });

  it("keeps the send button disabled until content exists", () => {
    render(<ChatInput conversationId="c1" />);

    const send = screen.getByTitle("发送消息");
    expect(send).toBeDisabled();

    fireEvent.change(contentField(), { target: { value: "你好" } });
    expect(send).toBeEnabled();
    expect(screen.getByText("2 / 1000 字")).toBeInTheDocument();
  });

  it("clears the input after a successful send", async () => {
    sendMessage.mockResolvedValue({ success: true, message: "发送成功" });
    const onSentSuccess = vi.fn();
    render(<ChatInput conversationId="c1" onSentSuccess={onSentSuccess} />);

    fireEvent.change(contentField(), { target: { value: "今晚可以面交吗" } });
    fireEvent.submit(contentField().form!);

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    const formData = sendMessage.mock.calls[0][1] as FormData;
    expect(formData.get("conversationId")).toBe("c1");
    expect(formData.get("content")).toBe("今晚可以面交吗");
    await waitFor(() => expect(onSentSuccess).toHaveBeenCalled());
    await waitFor(() => expect(contentField()).toHaveValue(""));
  });

  it("keeps content and shows the error with retry after failure", async () => {
    sendMessage.mockResolvedValue({ success: false, message: "消息包含敏感违规内容，发送失败" });
    render(<ChatInput conversationId="c1" />);

    fireEvent.change(contentField(), { target: { value: "加个微信" } });
    fireEvent.submit(contentField().form!);

    expect(
      await screen.findByText("消息包含敏感违规内容，发送失败"),
    ).toBeInTheDocument();
    expect(contentField()).toHaveValue("加个微信");
  });

  it("submits on Enter without shift", () => {
    render(<ChatInput conversationId="c1" />);

    fireEvent.change(contentField(), { target: { value: "你好" } });
    fireEvent.keyDown(contentField(), { key: "Enter", shiftKey: false });

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not submit on Shift+Enter or while composing", () => {
    render(<ChatInput conversationId="c1" />);

    fireEvent.change(contentField(), { target: { value: "你好" } });
    fireEvent.keyDown(contentField(), { key: "Enter", shiftKey: true });
    expect(sendMessage).not.toHaveBeenCalled();

    fireEvent.compositionStart(contentField());
    fireEvent.keyDown(contentField(), { key: "Enter" });
    expect(sendMessage).not.toHaveBeenCalled();

    fireEvent.compositionEnd(contentField());
  });
});
