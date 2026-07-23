import React from "react";
import Link from "next/link";
import { ChevronRight, Home } from "lucide-react";
import { cn } from "@/lib/utils";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  className?: string;
}

export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn("flex items-center gap-1.5 text-xs text-slate-500 sm:text-sm", className)}
    >
      <Link
        href="/"
        className="flex items-center gap-1 font-medium text-slate-500 transition hover:text-slate-900 dark:hover:text-slate-200"
      >
        <Home className="size-3.5" />
        <span className="sr-only">首页</span>
      </Link>
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <React.Fragment key={index}>
            <ChevronRight className="size-3.5 shrink-0 text-slate-400" />
            {item.href && !isLast ? (
              <Link
                href={item.href}
                className="font-medium text-slate-500 transition hover:text-slate-900 dark:hover:text-slate-200"
              >
                {item.label}
              </Link>
            ) : (
              <span className="font-semibold text-slate-900 truncate max-w-[200px] sm:max-w-[300px] dark:text-slate-100">
                {item.label}
              </span>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
