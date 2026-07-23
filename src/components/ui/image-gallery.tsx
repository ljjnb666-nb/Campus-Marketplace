"use client";

import React, { useState } from "react";
import { ImageOff, ZoomIn } from "lucide-react";
import { cn } from "@/lib/utils";

interface ImageGalleryProps {
  images?: { id?: string; url: string }[] | string[];
  title?: string;
  className?: string;
}

export function ImageGallery({ images = [], title = "商品图片", className }: ImageGalleryProps) {
  const normalizedImages = Array.isArray(images)
    ? images.map((img) => (typeof img === "string" ? img : img.url))
    : [];

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);

  const hasImages = normalizedImages.length > 0;
  const currentUrl = hasImages ? normalizedImages[selectedIndex] : null;

  return (
    <div className={cn("space-y-3", className)}>
      {/* 主图大框 */}
      <div className="group relative aspect-4/3 sm:aspect-16/10 w-full overflow-hidden rounded-3xl border border-slate-200/80 bg-slate-100 dark:border-slate-800 dark:bg-slate-900">
        {hasImages && currentUrl ? (
          <>
            <img
              src={currentUrl}
              alt={`${title} - 图片 ${selectedIndex + 1}`}
              className="h-full w-full object-contain sm:object-cover transition-all duration-300"
            />
            {/* 点击放大浮层 */}
            <button
              type="button"
              onClick={() => setIsLightboxOpen(true)}
              className="absolute right-3 bottom-3 flex size-9 items-center justify-center rounded-2xl bg-slate-900/60 text-white backdrop-blur-md opacity-0 transition-opacity group-hover:opacity-100 hover:bg-slate-900/80"
              title="查看大图"
            >
              <ZoomIn className="size-4" />
            </button>
          </>
        ) : (
          /* 专业的 EmptyImagePlaceholder 占位 */
          <div className="flex h-full w-full flex-col items-center justify-center text-slate-300 dark:text-slate-600">
            <ImageOff className="size-12 stroke-[1.5]" />
            <span className="mt-2 text-xs sm:text-sm font-medium">暂无实物图片</span>
          </div>
        )}
      </div>

      {/* 缩略图切换链 (只要大于 1 张) */}
      {normalizedImages.length > 1 && (
        <div className="flex items-center gap-2.5 overflow-x-auto pb-1 scrollbar-hide">
          {normalizedImages.map((url, idx) => {
            const active = idx === selectedIndex;
            return (
              <button
                key={idx}
                type="button"
                onClick={() => setSelectedIndex(idx)}
                className={cn(
                  "relative aspect-square size-16 shrink-0 overflow-hidden rounded-xl border-2 bg-slate-100 transition-all focus:outline-none dark:bg-slate-900",
                  active
                    ? "border-indigo-600 ring-2 ring-indigo-500/20"
                    : "border-slate-200/80 opacity-70 hover:opacity-100 dark:border-slate-800"
                )}
              >
                <img src={url} alt={`缩略图 ${idx + 1}`} className="h-full w-full object-cover" />
              </button>
            );
          })}
        </div>
      )}

      {/* 大图 View Modal */}
      {isLightboxOpen && currentUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur-md animate-fade-in"
          onClick={() => setIsLightboxOpen(false)}
        >
          <img
            src={currentUrl}
            alt={title}
            className="max-h-[90vh] max-w-[90vw] rounded-2xl object-contain shadow-2xl"
          />
        </div>
      )}
    </div>
  );
}
