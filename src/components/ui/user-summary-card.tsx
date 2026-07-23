import React from "react";
import { Award, CheckCircle2, ShieldCheck } from "lucide-react";

interface UserSummary {
  id: string;
  name: string;
  avatarUrl?: string | null;
  schoolName?: string;
  completedOrdersCount?: number;
  positiveReviewRate?: number | null;
  verificationStatus?: string;
  createdAt?: Date | string;
}

interface UserSummaryCardProps {
  user: UserSummary;
  compact?: boolean;
}

export function UserSummaryCard({ user, compact = false }: UserSummaryCardProps) {
  function formatJoinedDate(value?: Date | string) {
    if (!value) return "同学";
    const date = new Date(value);
    return `${date.getFullYear()}年入驻`;
  }

  const positiveRateText =
    typeof user.positiveReviewRate === "number" && user.positiveReviewRate > 0
      ? `${(user.positiveReviewRate * 100).toFixed(0)}%`
      : "100%";

  if (compact) {
    return (
      <div className="flex items-center gap-2.5 rounded-2xl bg-slate-50/80 p-2.5 border border-slate-100 dark:bg-slate-950/40 dark:border-slate-800">
        <div className="size-8 shrink-0 flex items-center justify-center rounded-full bg-indigo-100 text-indigo-700 font-bold text-xs">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt={user.name} className="h-full w-full rounded-full object-cover" />
          ) : (
            user.name.slice(0, 1)
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold text-slate-900 truncate dark:text-slate-100">{user.name}</p>
          <p className="text-[10px] text-slate-400 truncate">{user.schoolName || "认证高校"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-950/40 space-y-3">
      {/* 头像 + 姓名 + 标签 */}
      <div className="flex items-center gap-3">
        <div className="size-12 shrink-0 flex items-center justify-center rounded-full bg-indigo-100 text-indigo-700 font-bold text-sm">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt={user.name} className="h-full w-full rounded-full object-cover" />
          ) : (
            user.name.slice(0, 1)
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <h4 className="font-bold text-slate-900 truncate text-sm dark:text-slate-100">
              {user.name}
            </h4>
            {user.verificationStatus === "VERIFIED" && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                <ShieldCheck className="size-3" />
                已实名
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 truncate mt-0.5">
            {user.schoolName || "认证校园"} · {formatJoinedDate(user.createdAt)}
          </p>
        </div>
      </div>

      {/* 履约信用指标 */}
      <div className="grid grid-cols-2 gap-2 pt-1">
        <div className="rounded-xl bg-white p-2.5 border border-slate-100 text-center dark:bg-slate-900 dark:border-slate-800">
          <div className="flex items-center justify-center gap-1 text-[11px] text-slate-400">
            <CheckCircle2 className="size-3 text-emerald-500" />
            <span>成功履约</span>
          </div>
          <p className="mt-0.5 text-sm font-bold text-slate-900 dark:text-slate-100">
            {user.completedOrdersCount ?? 0} 单
          </p>
        </div>

        <div className="rounded-xl bg-white p-2.5 border border-slate-100 text-center dark:bg-slate-900 dark:border-slate-800">
          <div className="flex items-center justify-center gap-1 text-[11px] text-slate-400">
            <Award className="size-3 text-amber-500" />
            <span>好评率</span>
          </div>
          <p className="mt-0.5 text-sm font-bold text-slate-900 dark:text-slate-100">
            {positiveRateText}
          </p>
        </div>
      </div>
    </div>
  );
}
