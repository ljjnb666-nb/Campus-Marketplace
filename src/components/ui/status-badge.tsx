import React from "react";
import { cn } from "@/lib/utils";

export type StatusBadgeVariant = "success" | "warning" | "danger" | "info" | "neutral" | "primary";
type VariantType = StatusBadgeVariant;

interface StatusBadgeProps {
  label: string;
  variant?: VariantType;
  size?: "sm" | "md";
  dot?: boolean;
  className?: string;
}

const variantStyles: Record<VariantType, string> = {
  success: "bg-emerald-50 text-emerald-700 border-emerald-200/60 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800",
  warning: "bg-amber-50 text-amber-700 border-amber-200/60 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800",
  danger: "bg-rose-50 text-rose-700 border-rose-200/60 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800",
  info: "bg-sky-50 text-sky-700 border-sky-200/60 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-800",
  neutral: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
  primary: "bg-indigo-50 text-indigo-700 border-indigo-200/60 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-800",
};

const dotStyles: Record<VariantType, string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
  info: "bg-sky-500",
  neutral: "bg-slate-400",
  primary: "bg-indigo-500",
};

export function StatusBadge({
  label,
  variant = "neutral",
  size = "md",
  dot = false,
  className,
}: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium transition-colors",
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
        variantStyles[variant],
        className
      )}
    >
      {dot && <span className={cn("size-1.5 rounded-full shrink-0", dotStyles[variant])} />}
      <span>{label}</span>
    </span>
  );
}
