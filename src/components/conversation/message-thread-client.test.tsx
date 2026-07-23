import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageThreadClient } from "@/components/conversation/message-thread-client";

vi.mock("@/components/trust/report-form", () => ({
  ReportForm: ({ messageId }: { messageId?: string }) => (
    <div data-testid="message-report-form">{messageId}</div>
  ),
}));

describe("MessageThreadClient", () => {
  it("renders report entry only for messages sent by the counterpart", () => {
    render(
      <MessageThreadClient
        conversationId="conversation-1"
        currentUserId="user-1"
        reportAction={async () => ({ success: false, message: "" })}
        initialMessages={[
          {
            id: "message-1",
            senderId: "user-1",
            senderName: "我自己",
            type: "DIRECT",
            isRead: true,
            content: "这是我发出的消息",
            createdAt: "2026-07-18T10:00:00.000Z",
          },
          {
            id: "message-2",
            senderId: "user-2",
            senderName: "对方同学",
            type: "DIRECT",
            isRead: true,
            content: "这是对方发来的消息",
            createdAt: "2026-07-18T10:05:00.000Z",
          },
        ]}
      />,
    );

    const reportEntries = screen.getAllByTestId("message-report-form");
    expect(reportEntries).toHaveLength(1);
    expect(reportEntries[0]?.textContent).toContain("message-2");
  });
});
