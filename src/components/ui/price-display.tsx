import React from "react";
import { cn } from "@/lib/utils";

interface PriceDisplayProps {
  price: number | string | { toString: () => string };
  originalPrice?: number | string | { toString: () => string } | null;
  unit?: string | null;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

export function PriceDisplay({
  price,
  originalPrice,
  unit,
  size = "md",
  className,
}: PriceDisplayProps) {
  const numericPrice = typeof price === "number" ? price : parseFloat(price.toString());
  const numericOriginal = originalPrice
    ? typeof originalPrice === "number"
      ? originalPrice
      : parseFloat(originalPrice.toString())
    : null;

  const sizeClasses = {
    sm: "text-base font-bold",
    md: "text-lg sm:text-xl font-bold",
    lg: "text-2xl sm:text-3xl font-extrabold tracking-tight",
    xl: "text-3xl sm:text-4xl font-black tracking-tight",
  };

  const symbolSizes = {
    sm: "text-xs font-semibold mr-0.5",
    md: "text-sm font-semibold mr-0.5",
    lg: "text-base font-bold mr-1",
    xl: "text-lg font-bold mr-1",
  };

  return (
    <div className={cn("inline-flex items-baseline gap-2 flex-wrap", className)}>
      <span className={cn("text-indigo-600 dark:text-indigo-400", sizeClasses[size])}>
        <span className={symbolSizes[size]}>¥</span>
        {isNaN(numericPrice) ? "0.00" : numericPrice.toFixed(2)}
        {unit && (
          <span className="ml-1 text-xs sm:text-sm font-normal text-slate-500 dark:text-slate-400">
            /{unit}
          </span>
        )}
      </span>
      {numericOriginal && !isNaN(numericOriginal) && numericOriginal > numericPrice && (
        <span className="text-xs sm:text-sm text-slate-400 line-through dark:text-slate-500">
          ¥{numericOriginal.toFixed(2)}
        </span>
      )}
    </div>
  );
}
