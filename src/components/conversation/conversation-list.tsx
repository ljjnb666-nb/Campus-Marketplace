"use client";

import { useState } from "react";
import Link from "next/link";
import { Search, ShieldCheck, Info, AlertCircle } from "lucide-react";
import type { ConversationListItem } from "@/repositories/conversation-repository";

interface ConversationListProps {
  items: ConversationListItem[];
  selectedId?: string;
  onSelect?: (id: string) => void;
}

const BIZ_LABELS: Record<string, { label: string; color: string }> = {
  PRODUCT: { label: "二手商品", color: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300" },
  ERRAND: { label: "跑腿任务", color: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300" },
  SERVICE: { label: "技能服务", color: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300" },
  RENTAL: { label: "物品租赁", color: "bg-purple-50 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300" },
  PRODUCT_ORDER: { label: "交易订单", color: "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300" },
  RENTAL_ORDER: { label: "租赁订单", color: "bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300" },
};

function formatRelativeTime(dateString: string) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  if (diffMins < 1) return "刚刚";
  if (diffMins < 60) return `${diffMins}分钟前`;
  if (diffHours < 24) return `${diffHours}小时前`;
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function ConversationList({
  items,
  selectedId,
  onSelect,
}: ConversationListProps) {
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<string>("ALL");

  const filteredItems = items.filter((item) => {
    if (filterType !== "ALL" && item.bizType !== filterType) {
      return false;
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        item.counterpartName.toLowerCase().includes(q) ||
        item.bizTitle.toLowerCase().includes(q) ||
        item.lastMessageContent.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="flex h-full flex-col bg-white dark:bg-slate-900 border-r border-slate-200/80 dark:border-slate-800">
      {/* 1. 顶部标题与搜索栏 */}
      <div className="p-4 space-y-3 border-b border-slate-100 dark:border-slate-800">
        <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
          消息与沟通
        </h2>

        <div className="relative">
          <Search className="absolute left-3 top-2.5 size-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索联系人、交易或消息..."
            className="w-full rounded-2xl border border-slate-200 bg-slate-50 pl-9 pr-4 py-2 text-xs text-slate-900 outline-none transition focus:border-indigo-500 focus:bg-white dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
          />
        </div>

        {/* 2. 类型筛选分类 Tab */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pt-1">
          {[
            { key: "ALL", label: "全部" },
            { key: "PRODUCT", label: "二手" },
            { key: "ERRAND", label: "跑腿" },
            { key: "SERVICE", label: "服务" },
            { key: "RENTAL", label: "租赁" },
            { key: "PRODUCT_ORDER", label: "订单" },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFilterType(tab.key)}
              className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold transition ${
                filterType === tab.key
                  ? "bg-slate-900 text-white dark:bg-indigo-600"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* 3. 会话项列表 */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
        {filteredItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 text-center space-y-2">
            <Info className="size-8 text-slate-300 dark:text-slate-600" />
            <p className="text-xs font-semibold text-slate-500">未找到相关会话记录</p>
          </div>
        ) : (
          filteredItems.map((item) => {
            const isSelected = item.id === selectedId;
            const biz = BIZ_LABELS[item.bizType] || {
              label: "交易沟通",
              color: "bg-slate-100 text-slate-700",
            };

            const content = (
              <div
                className={`group flex items-start gap-3 p-3.5 transition cursor-pointer ${
                  isSelected
                    ? "bg-indigo-50/70 border-l-4 border-indigo-600 dark:bg-indigo-950/40 dark:border-indigo-500"
                    : "hover:bg-slate-50 dark:hover:bg-slate-800/60"
                }`}
              >
                {/* 对方头像 */}
                <div className="relative size-11 shrink-0 flex items-center justify-center rounded-full bg-indigo-100 text-indigo-700 font-bold text-sm">
                  {item.counterpartAvatarUrl ? (
                    <img
                      src={item.counterpartAvatarUrl}
                      alt={item.counterpartName}
                      className="h-full w-full rounded-full object-cover"
                    />
                  ) : (
                    (item.counterpartName || "用").slice(0, 1)
                  )}
                  {item.hasUnread && (
                    <span className="absolute -right-0.5 -top-0.5 size-3.5 rounded-full bg-rose-500 ring-2 ring-white dark:ring-slate-900" />
                  )}
                </div>

                {/* 会话内容快照 */}
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex items-center gap-1.5 truncate">
                      <span className="font-bold text-slate-900 text-xs truncate dark:text-slate-100">
                        {item.counterpartName}
                      </span>
                      {item.counterpartVerificationStatus === "VERIFIED" && (
                        <ShieldCheck className="size-3.5 text-emerald-500 shrink-0" />
                      )}
                    </div>
                    <span className="text-[10px] text-slate-400 shrink-0">
                      {formatRelativeTime(item.lastMessageAt)}
                    </span>
                  </div>

                  {/* 业务类型与关联标题 */}
                  <div className="flex items-center gap-1.5 truncate">
                    <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold ${biz.color}`}>
                      {biz.label}
                    </span>
                    <span className="text-[11px] font-medium text-slate-500 truncate dark:text-slate-400">
                      {item.bizTitle}
                    </span>
                  </div>

                  {/* 最新消息 preview */}
                  <p className={`text-xs truncate ${item.hasUnread ? "font-bold text-slate-900 dark:text-slate-100" : "text-slate-500 dark:text-slate-400"}`}>
                    {item.lastMessageContent}
                  </p>

                  {/* 履约订单在线标识 */}
                  {item.hasActiveOrder && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400 pt-0.5">
                      <AlertCircle className="size-3" />
                      有正在履约中的订单
                    </span>
                  )}
                </div>
              </div>
            );

            if (onSelect) {
              return (
                <div key={item.id} onClick={() => onSelect(item.id)}>
                  {content}
                </div>
              );
            }

            return (
              <Link key={item.id} href={`/messages/${item.id}`}>
                {content}
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
