import React from "react";
import { cn } from "@/lib/utils";

interface MobileActionBarProps {
  children: React.ReactNode;
  className?: string;
}

export function MobileActionBar({ children, className }: MobileActionBarProps) {
  return (
    <div
      className={cn(
        "fixed bottom-0 left-0 right-0 z-40 flex items-center justify-between gap-3 border-t border-slate-200/80 bg-white/90 p-3 shadow-lg backdrop-blur-lg lg:hidden dark:border-slate-800 dark:bg-slate-900/90",
        "pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
        className
      )}
    >
      {children}
    </div>
  );
}
