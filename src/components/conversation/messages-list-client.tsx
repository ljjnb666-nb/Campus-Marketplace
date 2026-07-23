"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ConversationListItem } from "@/repositories/conversation-repository";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function MessagesListClient({
  initialItems,
}: {
  initialItems: ConversationListItem[];
}) {
  const [items, setItems] = useState(initialItems);
  const [keyword, setKeyword] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function refreshConversations() {
      const response = await fetch("/api/messages/conversations", {
        cache: "no-store",
      });

      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as {
        items: ConversationListItem[];
      };

      if (!cancelled) {
        setItems(data.items);
      }
    }

    void refreshConversations();
    const timer = window.setInterval(() => {
      void refreshConversations();
    }, 30000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const filteredItems = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();

    return items.filter((item) => {
      const matchesUnread = !unreadOnly || item.hasUnread;
      const matchesKeyword =
        normalizedKeyword.length === 0 ||
        item.title.toLowerCase().includes(normalizedKeyword) ||
        item.counterpartName.toLowerCase().includes(normalizedKeyword) ||
        item.lastMessageContent.toLowerCase().includes(normalizedKeyword);

      return matchesUnread && matchesKeyword;
    });
  }, [items, keyword, unreadOnly]);

  return (
    <div className="space-y-6">
      <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid gap-4 md:grid-cols-[1fr_auto]">
          <label className="flex flex-col gap-2 text-sm text-slate-700">
            搜索会话
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="按标题、对方昵称或消息内容搜索"
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
            />
          </label>
          <label className="flex items-center gap-3 self-end rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(event) => setUnreadOnly(event.target.checked)}
            />
            只看未读
          </label>
        </div>
      </div>

      <div className="grid gap-4">
        {filteredItems.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            {items.length === 0
              ? "你还没有会话，可以从商品、任务或服务详情页发起沟通。"
              : "没有符合当前筛选条件的会话。"}
          </div>
        ) : (
          filteredItems.map((item) => (
            <Link
              key={item.id}
              href={`/messages/${item.id}`}
              className={`rounded-[28px] border bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 ${
                item.hasUnread ? "border-amber-300" : "border-slate-200"
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <h2 className="text-lg font-semibold text-slate-950">{item.title}</h2>
                    {item.hasUnread ? (
                      <span className="rounded-full bg-amber-200 px-2 py-1 text-xs font-medium text-amber-900">
                        未读
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm text-slate-500">
                    对方：{item.counterpartName} · {item.counterpartSchoolName}
                  </p>
                  <p className="line-clamp-2 text-sm text-slate-600">
                    {item.lastMessageSenderName}：{item.lastMessageContent}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-slate-500">
                  {formatDate(item.lastMessageAt)}
                </span>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
