import React from "react";
import { cn } from "@/lib/utils";

interface FormSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export function FormSection({
  title,
  description,
  children,
  className,
}: FormSectionProps) {
  return (
    <div
      className={cn(
        "rounded-3xl border border-slate-200/80 bg-white p-6 sm:p-8 shadow-xs dark:border-slate-800 dark:bg-slate-900 space-y-6",
        className
      )}
    >
      <div className="border-b border-slate-100 pb-4 dark:border-slate-800 space-y-1">
        <h3 className="text-base sm:text-lg font-bold text-slate-900 dark:text-slate-100">
          {title}
        </h3>
        {description && (
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
            {description}
          </p>
        )}
      </div>
      <div className="space-y-5">{children}</div>
    </div>
  );
}

interface FormFieldProps {
  label: React.ReactNode;
  required?: boolean;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}

export function FormField({
  label,
  required = false,
  hint,
  error,
  children,
  className,
}: FormFieldProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between">
        <label className="text-xs sm:text-sm font-semibold text-slate-700 dark:text-slate-300">
          {label}
          {required && <span className="ml-1 text-rose-500">*</span>}
        </label>
        {hint && (
          <span className="text-[11px] text-slate-400 font-normal">{hint}</span>
        )}
      </div>
      {children}
      {error && <p className="text-xs text-rose-600 font-medium">{error}</p>}
    </div>
  );
}
