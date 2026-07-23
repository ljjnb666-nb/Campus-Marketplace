import React from "react";
import { FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  title = "暂无数据",
  description = "当前没有找到相关内容，请稍后再试或调整搜索过滤条件。",
  icon: Icon = FolderOpen,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-3xl border border-dashed border-slate-200 bg-white/60 p-8 text-center sm:p-12 dark:border-slate-800 dark:bg-slate-900/40",
        className
      )}
    >
      <div className="flex size-14 items-center justify-center rounded-2xl bg-slate-100/80 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
        <Icon className="size-7" />
      </div>
      <h3 className="mt-4 text-base font-bold text-slate-900 sm:text-lg dark:text-slate-100">
        {title}
      </h3>
      <p className="mt-1.5 max-w-sm text-xs sm:text-sm text-slate-500 dark:text-slate-400">
        {description}
      </p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
