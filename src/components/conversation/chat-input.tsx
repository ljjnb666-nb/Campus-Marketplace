"use client";

import { useActionState, useRef, useState } from "react";
import { Send, AlertCircle, RefreshCw } from "lucide-react";
import { sendMessage } from "@/actions/conversation";

interface ChatInputProps {
  conversationId: string;
  disabled?: boolean;
  disabledHint?: string;
  onSentSuccess?: () => void;
}

export function ChatInput({
  conversationId,
  disabled = false,
  disabledHint,
  onSentSuccess,
}: ChatInputProps) {
  const [content, setContent] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [state, formAction, isPending] = useActionState(
    async (prevState: { success: boolean; message: string }, formData: FormData) => {
      const result = await sendMessage(prevState, formData);
      if (result.success) {
        setContent("");
        if (onSentSuccess) onSentSuccess();
      }
      return result;
    },
    { success: false, message: "" },
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !isComposing) {
      e.preventDefault();
      if (content.trim() && !isPending && !disabled) {
        const form = e.currentTarget.form;
        if (form) form.requestSubmit();
      }
    }
  };

  return (
    <div className="border-t border-slate-200/80 bg-white p-3 sm:p-4 dark:border-slate-800 dark:bg-slate-900 space-y-2">
      {disabledHint && (
        <div className="flex items-center gap-2 rounded-xl bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          <AlertCircle className="size-4 shrink-0 text-amber-500" />
          <span>{disabledHint}</span>
        </div>
      )}

      {state.message && !state.success && (
        <div className="flex items-center justify-between rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          <span>{state.message}</span>
          <button
            type="button"
            onClick={() => {
              if (textareaRef.current?.form) {
                textareaRef.current.form.requestSubmit();
              }
            }}
            className="inline-flex items-center gap-1 text-[11px] font-bold underline hover:text-rose-800"
          >
            <RefreshCw className="size-3" />
            <span>重试</span>
          </button>
        </div>
      )}

      <form action={formAction} className="relative flex items-end gap-2">
        <input type="hidden" name="conversationId" value={conversationId} />
        <textarea
          ref={textareaRef}
          name="content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          disabled={disabled || isPending}
          rows={2}
          maxLength={1000}
          placeholder={disabled ? "无法在此发送消息" : "输入沟通内容，Enter 发送，Shift+Enter 换行..."}
          className="w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 p-3 pr-12 text-xs text-slate-900 outline-none transition focus:border-indigo-500 focus:bg-white dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-indigo-500"
        />

        <button
          type="submit"
          disabled={disabled || isPending || !content.trim()}
          className="absolute right-3 bottom-3 inline-flex size-8 items-center justify-center rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-700 text-white shadow-md shadow-indigo-500/20 transition hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-40"
          title="发送消息"
        >
          <Send className="size-4" />
        </button>
      </form>

      <div className="flex items-center justify-between px-1 text-[10px] text-slate-400">
        <span>支持 Enter 发送消息</span>
        <span>{content.length} / 1000 字</span>
      </div>
    </div>
  );
}
