import React from "react";
import { CheckCircle2, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TimelineStep {
  key: string;
  title: string;
  time?: Date | string | null;
  description?: string;
  isCompleted: boolean;
  isCurrent: boolean;
}

interface OrderTimelineProps {
  steps: TimelineStep[];
}

export function OrderTimeline({ steps }: OrderTimelineProps) {
  function formatDate(value: Date | string) {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  return (
    <div className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900">
      <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-6">
        交易进度时间线
      </h3>
      <div className="relative flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 sm:gap-2">
        {/* 连接横线 (桌面端) */}
        <div className="hidden sm:block absolute top-4 left-6 right-6 h-0.5 bg-slate-100 dark:bg-slate-800 -z-0" />

        {steps.map((step, idx) => {
          return (
            <div
              key={step.key}
              className="relative z-10 flex sm:flex-col items-center gap-3 sm:gap-2 text-left sm:text-center flex-1 min-w-0"
            >
              {/* 节点图标 */}
              <div
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-colors",
                  step.isCompleted
                    ? "bg-emerald-600 text-white shadow-xs"
                    : step.isCurrent
                    ? "bg-indigo-600 text-white ring-4 ring-indigo-100 dark:ring-indigo-950"
                    : "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500"
                )}
              >
                {step.isCompleted ? (
                  <CheckCircle2 className="size-4" />
                ) : step.isCurrent ? (
                  <Clock className="size-4 animate-pulse" />
                ) : (
                  <span>{idx + 1}</span>
                )}
              </div>

              {/* 节点标题与时间 */}
              <div className="space-y-0.5 min-w-0">
                <p
                  className={cn(
                    "text-xs font-bold truncate",
                    step.isCompleted || step.isCurrent
                      ? "text-slate-900 dark:text-slate-100"
                      : "text-slate-400 dark:text-slate-500"
                  )}
                >
                  {step.title}
                </p>
                {step.time && (
                  <p className="text-[10px] text-slate-400">
                    {formatDate(step.time)}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
