"use client";

import { useEffect, useRef } from "react";
import { Info, ShoppingBag } from "lucide-react";
import type { ConversationMessageItem } from "@/repositories/conversation-repository";

interface ChatMessageListProps {
  currentUserId: string;
  messages: ConversationMessageItem[];
  nextCursor?: string | null;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
}

function formatMessageTime(dateString: string) {
  const date = new Date(dateString);
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatDateDivider(dateString: string) {
  const date = new Date(dateString);
  const now = new Date();

  if (date.toDateString() === now.toDateString()) {
    return "今天";
  }
  return date.toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

export function ChatMessageList({
  currentUserId,
  messages = [],
  nextCursor,
  onLoadMore,
  isLoadingMore = false,
}: ChatMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 初始自动定位到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages?.length]);

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50/50 dark:bg-slate-950/30"
    >
      {/* 顶部加载更多历史消息按钮 */}
      {nextCursor && (
        <div className="flex justify-center py-2">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={isLoadingMore}
            className="rounded-full bg-white px-4 py-1.5 text-xs font-semibold text-slate-600 shadow-2xs border border-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300 disabled:opacity-50"
          >
            {isLoadingMore ? "历史消息加载中..." : "查看更多历史消息"}
          </button>
        </div>
      )}

      {messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center space-y-2">
          <div className="size-12 flex items-center justify-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-slate-900">
            <Info className="size-6" />
          </div>
          <p className="text-sm font-bold text-slate-700 dark:text-slate-300">你们还没有开始聊天</p>
          <p className="text-xs text-slate-400">文明礼貌沟通，保障自身财物安全</p>
        </div>
      ) : (
        messages.map((message, index) => {
          const isSelf = message.senderId === currentUserId;
          const isSystem = message.type === "SYSTEM" || message.type === "ORDER_STATUS" || !message.senderId;

          // 是否需要日期分隔
          const prevMsg = messages[index - 1];
          const showDateDivider =
            !prevMsg ||
            new Date(message.createdAt).toDateString() !== new Date(prevMsg.createdAt).toDateString();

          return (
            <div key={message.id} className="space-y-3">
              {showDateDivider && (
                <div className="flex justify-center my-3">
                  <span className="rounded-full bg-slate-200/60 px-3 py-1 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {formatDateDivider(message.createdAt)}
                  </span>
                </div>
              )}

              {/* 系统 / 订单变更消息 */}
              {isSystem ? (
                <div className="flex justify-center my-2">
                  <div className="max-w-md flex items-start gap-2.5 rounded-2xl border border-indigo-100 bg-indigo-50/80 p-3 text-xs text-indigo-950 shadow-2xs dark:border-indigo-900/40 dark:bg-indigo-950/40 dark:text-indigo-200">
                    <ShoppingBag className="size-4 shrink-0 text-indigo-600 dark:text-indigo-400 mt-0.5" />
                    <div className="space-y-0.5 min-w-0">
                      <span className="font-bold block">{message.senderName}</span>
                      <p className="leading-relaxed whitespace-pre-wrap break-words">{message.content}</p>
                      <span className="text-[10px] text-indigo-600/70 dark:text-indigo-400/70 block pt-0.5">
                        {formatMessageTime(message.createdAt)}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                /* 普通私信气泡 */
                <div className={`flex items-end gap-2.5 ${isSelf ? "justify-end" : "justify-start"}`}>
                  {!isSelf && (
                    <div className="size-8 shrink-0 flex items-center justify-center rounded-full bg-slate-200 font-bold text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                      {message.senderAvatarUrl ? (
                        <img
                          src={message.senderAvatarUrl}
                          alt={message.senderName}
                          className="h-full w-full rounded-full object-cover"
                        />
                      ) : (
                        message.senderName.slice(0, 1)
                      )}
                    </div>
                  )}

                  <div className={`group relative max-w-[75%] sm:max-w-[65%] space-y-1 ${isSelf ? "items-end text-right" : "items-start text-left"}`}>
                    <div
                      className={`rounded-2xl px-4 py-2.5 text-xs shadow-2xs whitespace-pre-wrap break-words ${
                        isSelf
                          ? "bg-gradient-to-r from-indigo-600 to-indigo-700 text-white rounded-br-2xs"
                          : "bg-white border border-slate-200/80 text-slate-900 rounded-bl-2xs dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
                      }`}
                    >
                      {message.content}
                    </div>

                    <div className={`flex items-center gap-1 text-[10px] text-slate-400 ${isSelf ? "justify-end" : "justify-start"}`}>
                      <span>{formatMessageTime(message.createdAt)}</span>
                      {isSelf && (
                        <span>{message.isRead ? "· 已读" : "· 未读"}</span>
                      )}
                    </div>
                  </div>

                  {isSelf && (
                    <div className="size-8 shrink-0 flex items-center justify-center rounded-full bg-indigo-600 text-white font-bold text-xs">
                      我
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
