"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import type { ConversationActionState } from "@/actions/conversation";

const initialState: ConversationActionState = {
  success: false,
  message: "",
};

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
    >
      {pending ? "发送中..." : "发送消息"}
    </button>
  );
}

export function SendMessageForm({
  action,
  conversationId,
}: {
  action: (
    state: ConversationActionState,
    formData: FormData,
  ) => Promise<ConversationActionState>;
  conversationId: string;
}) {
  const router = useRouter();
  const [state, formAction] = useActionState(action, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success && state.redirectTo) {
      formRef.current?.reset();
      router.push(state.redirectTo);
      router.refresh();
    }
  }, [router, state.redirectTo, state.success]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="space-y-4 rounded-[24px] border border-slate-200 bg-white p-5"
    >
      <input type="hidden" name="conversationId" value={conversationId} />
      <label className="flex flex-col gap-2 text-sm">
        输入消息
        <textarea
          name="content"
          rows={4}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          placeholder="输入你想发送的内容"
          required
        />
      </label>

      {state.message ? <p className="text-sm text-rose-600">{state.message}</p> : null}

      <div className="flex justify-end">
        <SubmitButton />
      </div>
    </form>
  );
}
