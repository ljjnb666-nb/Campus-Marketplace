"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Flag, MoreVertical, ShieldCheck, UserX, Unlock } from "lucide-react";
import { ReportDialog } from "@/components/ui/report-dialog";
import { BlockDialog } from "@/components/conversation/block-dialog";
import { createReport } from "@/actions/trust";
import type { RelatedBizSnapshot } from "@/repositories/conversation-repository";

interface ChatHeaderProps {
  conversationId?: string;
  counterpart: {
    id: string;
    name: string;
    avatarUrl?: string | null;
    schoolName: string;
    verificationStatus: string;
    isBlockedByMe: boolean;
    hasBlockedMe: boolean;
  };
  relatedBiz?: RelatedBizSnapshot | null;
  onBack?: () => void;
  hasActiveOrder?: boolean;
}

export function ChatHeader({
  counterpart,
  relatedBiz,
  onBack,
  hasActiveOrder = false,
}: ChatHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);

  return (
    <>
      <div className="relative border-b border-slate-200/80 bg-white/95 px-4 py-3 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95 space-y-3">
        {/* 顶部同行：返回按钮、对方信息、操作菜单 */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="lg:hidden rounded-full p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                aria-label="返回会话列表"
              >
                <ArrowLeft className="size-5" />
              </button>
            )}

            <div className="relative size-10 shrink-0 flex items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-indigo-600 text-white font-bold text-sm shadow-xs">
              {counterpart.avatarUrl ? (
                <img
                  src={counterpart.avatarUrl}
                  alt={counterpart.name}
                  className="h-full w-full rounded-full object-cover"
                />
              ) : (
                counterpart.name.slice(0, 1)
              )}
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <h2 className="font-bold text-slate-900 truncate text-sm dark:text-slate-100">
                  {counterpart.name}
                </h2>
                {counterpart.verificationStatus === "VERIFIED" && (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                    <ShieldCheck className="size-3" />
                    已认证
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400 truncate mt-0.5">
                {counterpart.schoolName}
                {counterpart.isBlockedByMe && <span className="ml-1 text-rose-500 font-semibold">(已拉黑)</span>}
              </p>
            </div>
          </div>

          {/* 更多功能菜单按钮 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen(!menuOpen)}
              className="rounded-full p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              <MoreVertical className="size-5" />
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-11 z-30 w-44 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-lg dark:border-slate-800 dark:bg-slate-900 animate-in fade-in zoom-in-95 duration-100">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setReportOpen(true);
                  }}
                  className="w-full flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <Flag className="size-4 text-amber-500" />
                  <span>举报违规用户/消息</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setBlockOpen(true);
                  }}
                  className={`w-full flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800 ${counterpart.isBlockedByMe ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                >
                  {counterpart.isBlockedByMe ? (
                    <>
                      <Unlock className="size-4" />
                      <span>解除拉黑</span>
                    </>
                  ) : (
                    <>
                      <UserX className="size-4" />
                      <span>拉黑该同学</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 关联交易业务固定提醒卡片 */}
        {relatedBiz && (
          <div className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 p-2.5 border border-slate-100 dark:bg-slate-950/40 dark:border-slate-800 text-xs">
            <div className="flex items-center gap-2.5 min-w-0">
              {relatedBiz.coverUrl && (
                <img
                  src={relatedBiz.coverUrl}
                  alt={relatedBiz.title}
                  className="size-9 shrink-0 rounded-lg object-cover border border-slate-200 dark:border-slate-800"
                />
              )}
              <div className="min-w-0">
                <p className="font-semibold text-slate-900 truncate dark:text-slate-100">
                  {relatedBiz.title}
                </p>
                {relatedBiz.priceText && (
                  <p className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400">
                    {relatedBiz.priceText}
                  </p>
                )}
              </div>
            </div>

            <Link
              href={relatedBiz.detailUrl}
              className="shrink-0 inline-flex items-center gap-1 rounded-xl bg-white px-3 py-1.5 font-bold text-slate-700 border border-slate-200 shadow-2xs hover:bg-slate-100 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <span>查看详情</span>
              <ExternalLink className="size-3" />
            </Link>
          </div>
        )}
      </div>

      {/* 举报与拉黑弹窗 */}
      <ReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        action={async (formData) => {
          return createReport({ success: false, message: "" }, formData);
        }}
        targetType="USER"
        targetUserId={counterpart.id}
      />

      <BlockDialog
        open={blockOpen}
        onOpenChange={setBlockOpen}
        targetUserId={counterpart.id}
        targetUserName={counterpart.name}
        isBlockedByMe={counterpart.isBlockedByMe}
        hasActiveOrder={hasActiveOrder}
      />
    </>
  );
}
