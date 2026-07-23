import React from "react";
import { cn } from "@/lib/utils";

interface SectionHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function SectionHeader({
  title,
  description,
  action,
  className,
}: SectionHeaderProps) {
  return (
    <div className={cn("flex items-end justify-between gap-4 border-b border-slate-100 pb-3 dark:border-slate-800", className)}>
      <div>
        <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-slate-100">
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 text-xs sm:text-sm text-slate-500 dark:text-slate-400">
            {description}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
