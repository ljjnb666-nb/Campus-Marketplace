"use client";

import React, { useTransition, useState } from "react";
import { Loader2 } from "lucide-react";
import { UPLOAD_LIMITS } from "@/lib/upload-limits";

type RentalActionFormProps = {
  action: (formData: FormData) => Promise<{ success?: boolean; message?: string } | null | undefined>;
  submitLabel: string;
  className?: string;
  buttonClassName?: string;
  children: React.ReactNode;
  /** R09：照片独立上传，Server Action 只接收小型 asset:<id> token。 */
  uploadCategory?: "handover" | "return" | "report";
};

/**
 * R09：逐个文件走独立的 /api/upload/images，单个 10MiB 在 Caddy 12MiB
 * 与 proxy 13MiB 信封内；Server Action 本身只传 token，永远不背负多
 * 文件二进制（默认 1MiB body limit）。上传残留的 UPLOADED 资产由既有
 * orphan 清理；业务事务在服务端重新校验每个 token。
 */
async function uploadEvidenceForAction(formData: FormData, category: "handover" | "return" | "report") {
  const limits = UPLOAD_LIMITS[category];
  const keys = ["photos", "evidencePhotos"] as const;
  const pending: Array<{ key: typeof keys[number]; file: File }> = [];
  for (const key of keys) {
    for (const value of formData.getAll(key)) {
      if (!(value instanceof File) || value.size === 0) continue;
      pending.push({ key, file: value });
    }
  }
  if (pending.length > limits.maxCount) {
    throw new Error(`最多上传${limits.maxCount}张图片`);
  }
  for (const { file } of pending) {
    if (file.size > limits.maxSize || !(limits.allowedTypes as readonly string[]).includes(file.type)) {
      throw new Error("图片格式不支持或大小超过限制");
    }
  }
  // 清除所有原始 File entries，防止它们意外进入 Server Action body。
  for (const key of keys) formData.delete(key);
  for (const { key, file } of pending) {
    const payload = new FormData();
    payload.set("category", category);
    payload.set("file", file);
    const res = await fetch("/api/upload/images", { method: "POST", body: payload });
    const data: unknown = await res.json().catch(() => null);
    const result = data as { success?: boolean; assetId?: unknown; error?: unknown } | null;
    if (!res.ok || result?.success !== true ||
        typeof result.assetId !== "string" || result.assetId.length === 0) {
      throw new Error(typeof result?.error === "string" ? result.error.slice(0, 160) : "图片上传失败，请重试");
    }
    formData.append(key, `asset:${result.assetId}`);
  }
}

// 包装服务端 action 表单：失败时展示 action 返回的 ActionState 错误信息
export function RentalActionForm({
  action,
  submitLabel,
  className,
  buttonClassName,
  children,
  uploadCategory,
}: RentalActionFormProps) {
  const [isPending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      try {
        if (uploadCategory) {
          await uploadEvidenceForAction(formData, uploadCategory);
        }
        const result = await action(formData);
        if (result && !result.success && result.message) {
          setErrorMsg(result.message);
        }
      } catch (error) {
        setErrorMsg(error instanceof Error ? error.message : "图片上传或提交失败，请重试");
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
