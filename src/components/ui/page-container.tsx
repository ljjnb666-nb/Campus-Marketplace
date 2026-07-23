import React from "react";
import { cn } from "@/lib/utils";

interface PageContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * standard: 1200px (普通页面/详情页)
   * wide: 1280px (广场大列表)
   * form: 768px (表单/阅读)
   * full: 无最大宽度限制
   */
  maxWidth?: "standard" | "wide" | "form" | "full";
  children: React.ReactNode;
}

export function PageContainer({
  maxWidth = "standard",
  className,
  children,
  ...props
}: PageContainerProps) {
  const maxWidthMap = {
    standard: "max-w-6xl", // 1152px ~ 1200px
    wide: "max-w-7xl",     // 1280px
    form: "max-w-3xl",     // 768px
    full: "max-w-full",
  };

  return (
    <div
      className={cn(
        "mx-auto w-full px-4 py-6 sm:px-6 sm:py-8 lg:px-8",
        maxWidthMap[maxWidth],
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
