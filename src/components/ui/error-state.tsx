"use client";

import React from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  title = "出错了，无法加载数据",
  description = "网络请求失败或服务器异常，请检查网络连接后重试。",
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-3xl border border-rose-100 bg-rose-50/50 p-8 text-center sm:p-12 dark:border-rose-950/40 dark:bg-rose-950/10",
        className
      )}
    >
      <div className="flex size-14 items-center justify-center rounded-2xl bg-rose-100 text-rose-600 dark:bg-rose-900/40 dark:text-rose-400">
        <AlertCircle className="size-7" />
      </div>
      <h3 className="mt-4 text-base font-bold text-rose-950 sm:text-lg dark:text-rose-200">
        {title}
      </h3>
      <p className="mt-1.5 max-w-sm text-xs sm:text-sm text-rose-700/80 dark:text-rose-300/80">
        {description}
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-6 inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-semibold text-white shadow-md shadow-rose-600/20 transition hover:bg-rose-700 focus:outline-none"
        >
          <RefreshCw className="size-3.5" />
          <span>重新尝试</span>
        </button>
      )}
    </div>
  );
}
