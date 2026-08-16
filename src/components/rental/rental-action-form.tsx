"use client";

import React, { useTransition, useState } from "react";
import { Loader2 } from "lucide-react";

type RentalActionFormProps = {
  action: (formData: FormData) => Promise<{ success?: boolean; message?: string } | null | undefined>;
  submitLabel: string;
  className?: string;
  buttonClassName?: string;
  children: React.ReactNode;
};

// 包装服务端 action 表单：失败时展示 action 返回的 ActionState 错误信息
export function RentalActionForm({
  action,
  submitLabel,
  className,
  buttonClassName,
  children,
}: RentalActionFormProps) {
  const [isPending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await action(formData);
      if (result && !result.success && result.message) {
        setErrorMsg(result.message);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className={className}>
      {children}
      {errorMsg && <p className="text-xs text-red-500">{errorMsg}</p>}
      <button
        type="submit"
        disabled={isPending}
        className={
          buttonClassName ??
          "w-full rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-500/30 transition hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-50"
        }
      >
        {isPending ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : submitLabel}
      </button>
    </form>
  );
}
