"use client";

import { useEffect, useState } from "react";
import type { TrustActionState } from "@/actions/trust";
import { ReportForm } from "@/components/trust/report-form";
import type { ConversationDetailPayload } from "@/repositories/conversation-repository";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function MessageThreadClient({
  conversationId,
  currentUserId,
  initialMessages,
  reportAction,
}: {
  conversationId: string;
  currentUserId: string;
  initialMessages: ConversationDetailPayload["messages"];
  reportAction: (
    state: TrustActionState,
    formData: FormData,
  ) => Promise<TrustActionState>;
}) {
  const [messages, setMessages] = useState(initialMessages);

  useEffect(() => {
    let cancelled = false;

    async function refreshMessages() {
      const response = await fetch(`/api/messages/conversations/${conversationId}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as ConversationDetailPayload;

      if (!cancelled) {
        setMessages(data.messages);
      }
    }

    const timer = window.setInterval(() => {
      void refreshMessages();
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [conversationId]);

  if (messages.length === 0) {
    return (
      <div className="rounded-2xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
        暂无消息，先发一条试试。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {messages.map((message) => {
        const isMine = message.senderId === currentUserId;

        return (
          <div key={message.id} className={`flex ${isMine ? "justify-end" : "justify-start"}`}>
            <div className="max-w-[85%]">
              <div
                className={`rounded-[24px] px-4 py-3 ${
                  isMine
                    ? "bg-slate-950 text-white"
                    : "border border-slate-200 bg-slate-50 text-slate-900"
                }`}
              >
                <p className="text-sm font-medium">{message.senderName}</p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{message.content}</p>
                <p className={`mt-3 text-xs ${isMine ? "text-slate-300" : "text-slate-500"}`}>
                  {formatDate(message.createdAt)}
                </p>
              </div>
              {!isMine && message.senderId ? (
                <div className="mt-3">
                  <ReportForm
                    action={reportAction}
                    targetType="MESSAGE"
                    messageId={message.id}
                    compact
                  />
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
