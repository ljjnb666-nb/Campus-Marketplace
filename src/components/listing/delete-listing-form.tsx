"use client";

import React, { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";

type DeleteAction = (
  formData: FormData,
) => Promise<{ success?: boolean; message?: string } | void | null | undefined>;

/**
 * Phase 8F（§70）：四域 listing 删除的统一确认表单——提交前明确
 * 「删除后不会恢复公开展示」；active-obligation / terminal denial 时
 * 展示服务端返回的中文提示（禁止 silent no-op）。pending disabled、
 * 错误 role=alert 可见、原生 confirm 键盘可用。
 */
export function DeleteListingForm({
  action,
  hiddenFieldName,
  hiddenValue,
  label = "删除",
  confirmMessage = "删除后该内容不会恢复公开展示，且无法恢复。确定删除吗？",
  buttonClassName = "rounded-full border border-rose-200 px-4 py-2 text-sm font-medium text-rose-700 transition hover:border-rose-300 hover:text-rose-800 disabled:opacity-50",
}: {
  action: DeleteAction;
  hiddenFieldName: string;
  hiddenValue: string;
  label?: string;
  confirmMessage?: string;
  buttonClassName?: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMsg(null);

    if (!window.confirm(confirmMessage)) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await action(formData);
      if (result && result.success === false && result.message) {
        setErrorMsg(result.message);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="inline-flex flex-col gap-1">
      <input type="hidden" name={hiddenFieldName} value={hiddenValue} />
      <button
        type="submit"
        disabled={isPending}
        aria-busy={isPending}
        className={buttonClassName}
      >
        {isPending ? (
          <Loader2 className="inline size-4 animate-spin" aria-hidden="true" />
        ) : (
          label
        )}
      </button>
      {errorMsg && (
        <p role="alert" className="max-w-56 text-xs text-red-500">
          {errorMsg}
        </p>
      )}
    </form>
  );
}
