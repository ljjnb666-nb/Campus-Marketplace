import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { sendMessage, createReport, blockUser, unblockUser } = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => ({ success: true, message: "发送成功" })),
  createReport: vi.fn(async () => ({ success: true, message: "" })),
  blockUser: vi.fn(async () => ({ success: true, message: "" })),
  unblockUser: vi.fn(async () => ({ success: true, message: "" })),
}));

vi.mock("@/actions/conversation", () => ({
  sendMessage,
}));

vi.mock("@/actions/trust", () => ({
  createReport,
  blockUser,
  unblockUser,
}));

import { ConversationLayout } from "@/components/conversation/conversation-layout";
import type { ConversationDetailPayload } from "@/repositories/conversation-repository";

function makePayload(overrides: {
  communicationPolicy: ConversationDetailPayload["communicationPolicy"];
  counterpart?: Partial<ConversationDetailPayload["counterpart"]>;
}): ConversationDetailPayload {
  return {
    id: "conversation-1",
    bizType: "PRODUCT",
    title: "商品咨询",
    counterpart: {
      id: "user-2",
      name: "对方同学",
      avatarUrl: null,
      schoolName: "示例大学",
      verificationStatus: "VERIFIED",
      isBlockedByMe: false,
      hasBlockedMe: false,
      ...overrides.counterpart,
    },
    communicationPolicy: overrides.communicationPolicy,
    relatedBiz: null,
    messages: [],
    nextCursor: null,
  };
}

const baseListItem = {
  id: "conversation-1",
  title: "商品咨询",
  bizType: "PRODUCT" as const,
  bizTitle: "高数教材",
  bizCoverUrl: null,
  bizTargetId: "product-1",
  counterpartId: "user-2",
  counterpartName: "对方同学",
  counterpartAvatarUrl: null,
  counterpartSchoolName: "示例大学",
  counterpartVerificationStatus: "VERIFIED",
  lastMessageSenderName: "我",
  lastMessageContent: "在吗",
  lastMessageAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  hasUnread: false,
  hasActiveOrder: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConversationLayout（8A-03 UI policy = server policy）", () => {
  it("NORMAL：输入可用且无屏蔽提示", () => {
    render(
      <ConversationLayout
        currentUserId="user-1"
        conversations={[baseListItem]}
        activeConversationPayload={makePayload({
          communicationPolicy: {
            pairBlocked: false,
            activeObligation: false,
            canSendMessage: true,
            mode: "NORMAL",
          },
        })}
        activeId="conversation-1"
      />,
    );

    const textarea = document.querySelector('textarea[name="content"]') as HTMLTextAreaElement;
    expect(textarea).toBeEnabled();
    expect(screen.queryByText(/消息屏蔽/)).not.toBeInTheDocument();
    expect(screen.queryByText(/必要交易沟通仍然开放/)).not.toBeInTheDocument();
  });

  it("BLOCKED + 无 obligation：输入禁用并按方向提示", () => {
    render(
      <ConversationLayout
        currentUserId="user-1"
        conversations={[baseListItem]}
        activeConversationPayload={makePayload({
          communicationPolicy: {
            pairBlocked: true,
            activeObligation: false,
            canSendMessage: false,
            mode: "BLOCKED",
          },
          counterpart: { isBlockedByMe: true },
        })}
        activeId="conversation-1"
      />,
    );

    const textarea = document.querySelector('textarea[name="content"]') as HTMLTextAreaElement;
    expect(textarea).toBeDisabled();
    expect(screen.getByText("你已拉黑该同学，解除拉黑后可恢复非交易沟通")).toBeInTheDocument();
  });

  it("BLOCKED（被对方拉黑）：输入禁用并提示存在消息屏蔽", () => {
    render(
      <ConversationLayout
        currentUserId="user-1"
        conversations={[baseListItem]}
        activeConversationPayload={makePayload({
          communicationPolicy: {
            pairBlocked: true,
            activeObligation: false,
            canSendMessage: false,
            mode: "BLOCKED",
          },
          counterpart: { hasBlockedMe: true },
        })}
        activeId="conversation-1"
      />,
    );

    const textarea = document.querySelector('textarea[name="content"]') as HTMLTextAreaElement;
    expect(textarea).toBeDisabled();
    expect(screen.getByText("你们之间存在消息屏蔽，当前无法发送")).toBeInTheDocument();
  });

  it("BLOCKED + active obligation：输入保持可用并显示履约例外提醒（§30）", () => {
    render(
      <ConversationLayout
        currentUserId="user-1"
        conversations={[{ ...baseListItem, hasActiveOrder: true }]}
        activeConversationPayload={makePayload({
          communicationPolicy: {
            pairBlocked: true,
            activeObligation: true,
            canSendMessage: true,
            mode: "EXISTING_OBLIGATION_OVERRIDE",
          },
          counterpart: { isBlockedByMe: true },
        })}
        activeId="conversation-1"
      />,
    );

    const textarea = document.querySelector('textarea[name="content"]') as HTMLTextAreaElement;
    expect(textarea).toBeEnabled();
    expect(
      screen.getByText(
        "你们之间存在拉黑关系，但当前仍有正在履行的交易。为完成交接/履约，必要交易沟通仍然开放。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("你已拉黑该同学，解除拉黑后可恢复非交易沟通"),
    ).not.toBeInTheDocument();
  });

  it("SOLD/terminal 等 unrelated 状态不产生履约例外提醒（§51：仅由 activeObligation 驱动）", () => {
    render(
      <ConversationLayout
        currentUserId="user-1"
        conversations={[{ ...baseListItem, hasActiveOrder: false }]}
        activeConversationPayload={makePayload({
          communicationPolicy: {
            pairBlocked: true,
            activeObligation: false,
            canSendMessage: false,
            mode: "BLOCKED",
          },
        })}
        activeId="conversation-1"
      />,
    );

    const textarea = document.querySelector('textarea[name="content"]') as HTMLTextAreaElement;
    expect(textarea).toBeDisabled();
    expect(screen.queryByText(/必要交易沟通仍然开放/)).not.toBeInTheDocument();
  });
});
