"use client";

import { useActionState } from "react";
import type { ReactNode } from "react";

import type { ConversationActionState } from "@/actions/conversation";

type ListingContactAction = (
  prevState: ConversationActionState | null,
  formData: FormData,
) => Promise<ConversationActionState>;

/**
 * Phase 6C-3：listing 会话发起表单（useActionState）。
 * 会话创建被 marketplace 能力门拒绝时，把统一受限/对手方不可用文案
 * 呈现在按钮下方（role=alert），不再落入 Next error boundary。
 */
export function ListingContactForm({
  action,
  fieldName,
  fieldValue,
  className,
  buttonClassName,
  children,
}: {
  action: ListingContactAction;
  fieldName: string;
  fieldValue: string;
  className?: string;
  buttonClassName?: string;
  children: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction} className={className}>
      <input type="hidden" name={fieldName} value={fieldValue} />
      <button type="submit" disabled={pending} className={buttonClassName}>
        {children}
      </button>
      {state && !state.success && state.message ? (
        <p role="alert" className="mt-2 text-xs font-medium text-rose-600 dark:text-rose-400">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
