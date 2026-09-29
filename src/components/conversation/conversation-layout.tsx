"use client";

import { useEffect } from "react";
import { MessageSquare, ShieldCheck } from "lucide-react";
import { ConversationList } from "@/components/conversation/conversation-list";
import { ChatHeader } from "@/components/conversation/chat-header";
import { ChatMessageList } from "@/components/conversation/chat-message-list";
import { ChatInput } from "@/components/conversation/chat-input";
import type { ConversationListItem, ConversationDetailPayload } from "@/repositories/conversation-repository";

interface ConversationLayoutProps {
  currentUserId: string;
  conversations: ConversationListItem[];
  activeConversationPayload?: ConversationDetailPayload | null;
  activeId?: string;
  onSelectConversation?: (id: string) => void;
  onRefresh?: () => void;
}

export function ConversationLayout({
  currentUserId,
  conversations,
  activeConversationPayload,
  activeId,
  onSelectConversation,
  onRefresh,
}: ConversationLayoutProps) {
  // 3秒智敏轮询
  useEffect(() => {
    if (!activeId || !onRefresh) return;

    const runPoll = () => {
      if (!document.hidden) {
        onRefresh();
      }
    };

    const timer = setInterval(runPoll, 4000);

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        onRefresh();
      }
    };

    window.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleVisibilityChange);

    return () => {
      clearInterval(timer);
      window.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleVisibilityChange);
    };
  }, [activeId, onRefresh]);

  const activeItem = conversations.find((c) => c.id === activeId);

  return (
    <div className="flex h-[calc(100vh-4rem)] w-full overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      {/* 1. 桌面端左侧会话列表（移动端在特定视图隐藏） */}
      <div className={`w-full lg:w-80 xl:w-96 shrink-0 ${activeId ? "hidden lg:block" : "block"}`}>
        <ConversationList
          items={conversations}
          selectedId={activeId}
          onSelect={onSelectConversation}
        />
      </div>

      {/* 2. 右侧聊天区域 */}
      <div className={`flex-1 flex-col h-full ${activeId ? "flex" : "hidden lg:flex"}`}>
        {activeId && activeConversationPayload ? (
          <div className="flex flex-col h-full min-h-0">
            {/* 2.1 聊天头部 */}
            <ChatHeader
              conversationId={activeConversationPayload.id}
              counterpart={activeConversationPayload.counterpart}
              relatedBiz={activeConversationPayload.relatedBiz}
              // 8A-03：交易义务提醒以服务器派生政策为准（列表项启发式仅作展示）
              hasActiveOrder={activeConversationPayload.communicationPolicy.activeObligation || activeItem?.hasActiveOrder || false}
              onBack={onSelectConversation ? () => onSelectConversation("") : undefined}
            />

            {/* 2.2 消息气泡区 */}
            <ChatMessageList
              currentUserId={currentUserId}
              messages={activeConversationPayload.messages}
              nextCursor={activeConversationPayload.nextCursor}
            />

            {/* 2.3 消息输入区（8A-03：禁用/放行一律跟随服务器派生沟通策略；
                blocked + active obligation 时保持可用并提示履约例外） */}
            <ChatInput
              conversationId={activeConversationPayload.id}
              disabled={!activeConversationPayload.communicationPolicy.canSendMessage}
              disabledHint={
                activeConversationPayload.communicationPolicy.mode === "BLOCKED"
                  ? activeConversationPayload.counterpart.isBlockedByMe
                    ? "你已拉黑该同学，解除拉黑后可恢复非交易沟通"
                    : "你们之间存在消息屏蔽，当前无法发送"
                  : undefined
              }
              warningNotice={
                activeConversationPayload.communicationPolicy.mode === "EXISTING_OBLIGATION_OVERRIDE"
                  ? "你们之间存在拉黑关系，但当前仍有正在履行的交易。为完成交接/履约，必要交易沟通仍然开放。"
                  : undefined
              }
              onSentSuccess={onRefresh}
            />
          </div>
        ) : (
          /* 未选择会话时的桌面端引导空状态 */
          <div className="flex h-full flex-col items-center justify-center p-8 text-center space-y-4 bg-slate-50/50 dark:bg-slate-950/20">
            <div className="size-16 flex items-center justify-center rounded-3xl bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400 shadow-sm">
              <MessageSquare className="size-8" />
            </div>
            <div className="space-y-1.5 max-w-sm">
              <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                校园安全私聊与沟通
              </h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                点击左侧会话列表开始交易沟通。请注意防范冒充客服、提前往未知账号转账等风险。
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-semibold text-emerald-700 shadow-2xs border border-emerald-100 dark:bg-slate-900 dark:border-emerald-900/40 dark:text-emerald-400">
              <ShieldCheck className="size-4" />
              <span>全站支持违规文本检测与实时防骚扰拉黑</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
