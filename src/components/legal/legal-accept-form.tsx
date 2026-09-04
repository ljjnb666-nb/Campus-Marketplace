"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { acceptRequiredPolicies, type LegalAcceptanceState } from "@/actions/legal";

const initialState: LegalAcceptanceState = {
  success: false,
  message: "",
};

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-full bg-slate-950 px-6 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
    >
      {pending ? "提交中..." : "同意并继续"}
    </button>
  );
}

export function LegalAcceptForm({
  documents,
}: {
  documents: { id: string; slug: string; title: string; version: number; effectiveDate: string }[];
}) {
  const [state, formAction] = useActionState(acceptRequiredPolicies, initialState);
  const [agreed, setAgreed] = useState(false);
  const router = useRouter();

  // 版本冲突：强制重新加载当前 required 集合，绝不在过期集合上重试
  useEffect(() => {
    if (state.requiresReload) {
      const timer = setTimeout(() => router.refresh(), 1200);
      return () => clearTimeout(timer);
    }
  }, [state.requiresReload, router]);

  useEffect(() => {
    if (state.success) {
      const timer = setTimeout(() => {
        router.push("/");
        router.refresh();
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [state.success, router]);

  return (
    <form action={formAction} className="mt-8 space-y-6">
      <ul className="space-y-3">
        {documents.map((document) => (
          <li
            key={document.id}
            className="rounded-[24px] border border-slate-200 bg-white p-5"
            data-testid="legal-accept-document"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Link
                href={`/legal/${document.slug}`}
                target="_blank"
                className="text-base font-semibold text-sky-700 underline-offset-2 hover:underline"
              >
                《{document.title}》
              </Link>
              <span className="text-xs text-slate-500">
                v{document.version} · 生效于 {document.effectiveDate}
              </span>
            </div>
            <input type="hidden" name="acceptedDocumentIds" value={document.id} />
          </li>
        ))}
      </ul>

      <label className="flex items-start gap-3 text-sm text-slate-700">
        <input
          type="checkbox"
          name="agreeLegal"
          value="on"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
          className="mt-1 size-4 rounded border-slate-300"
          required
        />
        <span>
          我已阅读并同意上述全部协议的当前生效版本（v
          {documents.map((document) => document.version).join("、v")}），同意记录将与版本绑定。
        </span>
      </label>

      {state.message ? (
        <p
          className={`text-sm ${state.success ? "text-emerald-600" : "text-rose-600"}`}
          data-testid="legal-accept-message"
        >
          {state.message}
          {state.requiresReload ? "，正在为你刷新最新版本…" : ""}
        </p>
      ) : null}

      <div className="flex items-center gap-4">
        <SubmitButton />
        <span className="text-xs text-slate-400">同意后即可继续使用平台的全部功能</span>
      </div>
    </form>
  );
}
