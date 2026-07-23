"use client";

import React, { useState, useTransition } from "react";
import { Star, X, Loader2, Award } from "lucide-react";

interface ActionResponse {
  success?: boolean;
  message?: string;
}

interface ReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: (formData: FormData) => Promise<ActionResponse | void>;
  orderId: string;
  targetUserId: string;
  orderType?: "PRODUCT" | "ERRAND" | "SERVICE" | "RENTAL";
}

const QUICK_TAGS = ["守时高效", "物品保存极佳", "沟通愉快", "态度好", "诚信靠谱", "超值推荐"];

export function ReviewDialog({
  open,
  onOpenChange,
  action,
  orderId,
  targetUserId,
}: ReviewDialogProps) {
  const [isPending, startTransition] = useTransition();
  const [rating, setRating] = useState(5);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [content, setContent] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!open) return null;

  function toggleTag(tag: string) {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    const formData = new FormData(e.currentTarget);
    formData.set("tags", selectedTags.join(","));
    formData.set("overallRating", rating.toString());

    startTransition(async () => {
      try {
        const res = await action(formData);
        if (res && res.success === false) {
          setErrorMsg(res.message || "提交评价失败");
        } else {
          onOpenChange(false);
          window.location.reload();
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "网络异常，请稍后重试";
        setErrorMsg(message);
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs animate-fade-in"
        onClick={() => onOpenChange(false)}
      />

      <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl animate-scale-in dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
          <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 font-bold text-base">
            <Award className="size-5" />
            <span>发表交易评价</span>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-xl p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
          >
            <X className="size-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <input type="hidden" name="orderId" value={orderId} />
          <input type="hidden" name="targetUserId" value={targetUserId} />
          <input type="hidden" name="rating" value={rating} />

          {/* 打星选择 */}
          <div className="space-y-1.5 text-center">
            <p className="text-xs font-semibold text-slate-500">总体服务满意度打分</p>
            <div className="flex justify-center gap-2">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  onClick={() => setRating(star)}
                  className="p-1 transition transform hover:scale-110"
                >
                  <Star
                    className={`size-7 ${
                      star <= rating
                        ? "fill-amber-400 text-amber-400"
                        : "fill-slate-100 text-slate-300 dark:fill-slate-800 dark:text-slate-700"
                    }`}
                  />
                </button>
              ))}
            </div>
          </div>

          {/* 快捷标签 */}
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">快捷印象标签</p>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_TAGS.map((tag) => {
                const isSelected = selectedTags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    className={`rounded-xl px-3 py-1 text-xs font-semibold transition ${
                      isSelected
                        ? "bg-indigo-600 text-white shadow-xs"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
                    }`}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 文字评价 */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              详细评价内容 (选填)
            </label>
            <textarea
              name="content"
              rows={3}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="评价对方的沟通态度、物品准时度或商品完好程度..."
              className="w-full rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-900 outline-none focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          {errorMsg && <p className="text-xs text-rose-600 font-medium">{errorMsg}</p>}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-5 py-2 text-xs font-bold text-white shadow-md hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-50"
            >
              {isPending && <Loader2 className="size-3.5 animate-spin" />}
              <span>提交评价</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
