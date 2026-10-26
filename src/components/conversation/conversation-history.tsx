"use client";

import { useEffect, useRef, useState } from "react";
import { ChatMessageList } from "./chat-message-list";
import type { ConversationDetailPayload, ConversationMessageItem } from "@/repositories/conversation-repository";

function mergeMessages(older: ConversationMessageItem[], latest: ConversationMessageItem[]) {
  const rows = new Map(older.map((message) => [message.id, message]));
  for (const message of latest) rows.set(message.id, message);
  return [...rows.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

// Mounted with the conversation ID as key: late responses cannot cross conversations.
export function ConversationHistory({ currentUserId, payload }: {
  currentUserId: string;
  payload: ConversationDetailPayload;
}) {
  const [history, setHistory] = useState<{ messages: ConversationMessageItem[]; cursor: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  // A poll can advance beyond the entire previous window. Restart pagination in
  // that case, rather than silently presenting two disconnected message ranges.
  const contiguous = history && (payload.messages.length === 0 || payload.messages.some(
    (message) => history.messages.some((old) => old.id === message.id),
  ));
  const messages = contiguous ? mergeMessages(history.messages, payload.messages) : payload.messages;
  const cursor = contiguous ? history.cursor : payload.nextCursor;

  async function loadMore() {
    if (!cursor || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/messages/conversations/${encodeURIComponent(payload.id)}?cursor=${encodeURIComponent(cursor)}`, {
        cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) throw new Error("HISTORY_UNAVAILABLE");
      const page: ConversationDetailPayload = await response.json();
      if (page.id !== payload.id || !Array.isArray(page.messages)) throw new Error("INVALID_HISTORY");
      if (!controller.signal.aborted) {
        setHistory({ messages: mergeMessages(page.messages, messages), cursor: page.nextCursor ?? null });
      }
    } catch {
      if (!controller.signal.aborted) setError("历史消息加载失败，请重试；登录失效时请重新登录。");
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setLoading(false);
      }
    }
  }

  return <>
    {error && <p role="alert" className="px-4 py-2 text-sm text-red-600">{error}</p>}
    <ChatMessageList currentUserId={currentUserId} messages={messages} nextCursor={cursor}
      onLoadMore={loadMore} isLoadingMore={loading} />
  </>;
}
