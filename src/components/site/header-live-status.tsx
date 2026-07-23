"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MessageSquare, Bell } from "lucide-react";

type HeaderLiveStatusProps = {
  initialMessageCount: number;
  initialNotificationCount: number;
};

type LiveSummaryResponse = {
  unreadNotifications: number;
  unreadConversations: number;
};

function CountBadge({ count }: { count: number }) {
  if (count <= 0) {
    return null;
  }

  return (
    <span className="absolute -right-1.5 -top-1.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white ring-2 ring-white dark:ring-slate-900">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function HeaderLiveStatus({
  initialMessageCount,
  initialNotificationCount,
}: HeaderLiveStatusProps) {
  const [counts, setCounts] = useState({
    unreadNotifications: initialNotificationCount,
    unreadConversations: initialMessageCount,
  });

  useEffect(() => {
    let isActive = true;

    async function refreshCounts() {
      try {
        const response = await fetch("/api/user/live-summary", {
          method: "GET",
          cache: "no-store",
        });

        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as LiveSummaryResponse;

        if (isActive) {
          setCounts({
            unreadNotifications: data.unreadNotifications,
            unreadConversations: data.unreadConversations,
          });
        }
      } catch {
        // Ignore transient network errors and try again on the next poll.
      }
    }

    const interval = window.setInterval(refreshCounts, 30000);

    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <>
      <div className="relative">
        <Link
          href="/messages"
          className="flex size-9 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-600 transition hover:border-indigo-300 hover:bg-slate-50 hover:text-indigo-600 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400 dark:hover:text-indigo-400"
          title="我的会话"
        >
          <MessageSquare className="size-4.5" />
        </Link>
        <CountBadge count={counts.unreadConversations} />
      </div>
      <div className="relative">
        <Link
          href="/notifications"
          className="flex size-9 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-600 transition hover:border-indigo-300 hover:bg-slate-50 hover:text-indigo-600 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400 dark:hover:text-indigo-400"
          title="我的通知"
        >
          <Bell className="size-4.5" />
        </Link>
        <CountBadge count={counts.unreadNotifications} />
      </div>
    </>
  );
}

