"use client";

import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  cancelPrivacyRequest,
  requestAccountDeletion,
  type PrivacyActionState,
} from "@/actions/privacy";
import { signOut } from "next-auth/react";

const initialState: PrivacyActionState = { success: false, message: "" };

function SubmitButton({ label, danger }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className={
        danger
          ? "rounded-full bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-rose-300"
          : "rounded-full bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
      }
    >
      {pending ? "处理中..." : label}
    </button>
  );
}

/**
 * Phase 9C-03：异步数据导出面板。
 *
 * 生命周期（全部状态中文，§39）：
 *   点击"导出我的数据" → POST /api/privacy/export（202，快速返回）
 *   → 正在排队（REQUESTED）/ 正在生成（IN_PROGRESS）
 *   → 可下载（COMPLETED + READY：同源代理下载链接 + 有效期）
 *   → 生成失败（REJECTED）/ 文件已过期（COMPLETED 但 artifact 已过期）
 *
 * HTTP 请求不承担数据构建与大 JSON delivery（INV-9C03-02）；下载走
 * GET /api/privacy/export/<requestId>/download 本人授权同源代理——浏览器
 * 永不接触 bucket/objectKey/内部端点（INV-9C03-09）。
 */

type ExportPhase = "idle" | "submitting" | "queued" | "generating" | "ready" | "failed" | "expired";

type ExportRequestView = {
  id: string;
  type: string;
  status: string;
  downloadAvailable: boolean;
  artifactExpiresAt: string | null;
  downloadPath: string | null;
};

const EXPORT_POLL_INTERVAL_MS = 2_000;
/** 有界轮询：约 5 分钟后提示刷新（worker 正常在秒级完成，上界只为防挂） */
const EXPORT_POLL_MAX_ATTEMPTS = 150;

function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function AsyncExportPanel() {
  const [phase, setPhase] = useState<ExportPhase>("idle");
  const [message, setMessage] = useState<string>("");
  const [download, setDownload] = useState<{ path: string; expiresAt: string | null } | null>(null);
  // 轮询会话令牌：新触发 / 组件卸载时递增，旧循环自行退出（无悬挂 timer）
  const pollSession = useRef(0);

  const applyRequest = useCallback((request: ExportRequestView): boolean => {
    if (request.downloadAvailable && request.downloadPath) {
      setDownload({ path: request.downloadPath, expiresAt: request.artifactExpiresAt });
      setPhase("ready");
      setMessage("");
      return true;
    }

    if (request.status === "COMPLETED") {
      setPhase("expired");
      setMessage("文件已过期，请重新申请");
      return true;
    }

    if (request.status === "REJECTED") {
      setPhase("failed");
      setMessage("生成失败，请稍后重试");
      return true;
    }

    if (request.status === "CANCELLED") {
      setPhase("idle");
      setMessage("请求已取消");
      return true;
    }

    if (request.status === "REQUESTED") {
      setPhase("queued");
      setMessage("正在排队");
      return false;
    }

    if (request.status === "IN_PROGRESS") {
      setPhase("generating");
      setMessage("正在生成");
      return false;
    }

    return false;
  }, []);

  /**
   * 有界轮询循环（会话令牌防重放/防悬挂）：读取 /api/privacy/requests，
   * 终态（可下载 / 过期 / 失败 / 取消）即停；非终态按固定间隔继续；
   * 约 5 分钟后提示刷新（worker 正常秒级完成，上界只为防挂）。
   */
  const pollUntilSettled = useCallback(
    async (sessionId: number) => {
      for (let attempt = 0; attempt < EXPORT_POLL_MAX_ATTEMPTS; attempt += 1) {
        if (pollSession.current !== sessionId) return;

        try {
          const response = await fetch("/api/privacy/requests", { cache: "no-store" });

          if (response.ok) {
            const data = (await response.json()) as { requests?: ExportRequestView[] };
            const latest = (data.requests ?? []).find(
              (request) => request.type === "DATA_EXPORT",
            );

            if (pollSession.current !== sessionId) return;

            if (!latest) {
              setPhase("idle");
              setMessage("");
              return;
            }

            if (applyRequest(latest)) {
              return;
            }
          }
          // 查询失败（网络/5xx）：瞬态，继续下一轮
        } catch {
          // 瞬态网络错误：继续下一轮
        }

        await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_INTERVAL_MS));
      }

      if (pollSession.current === sessionId) {
        setPhase("generating");
        setMessage("仍在生成，请稍后刷新页面查看");
      }
    },
    [applyRequest],
  );

  const startPolling = useCallback(() => {
    const sessionId = pollSession.current + 1;
    pollSession.current = sessionId;
    void pollUntilSettled(sessionId);
  }, [pollUntilSettled]);

  // 挂载时恢复状态（多 tab / 页面刷新后接续既有生命周期）；无导出记录时
  // 首轮查询即收敛为 idle，不会持续轮询。卸载时递增会话令牌停止循环。
  useEffect(() => {
    const sessionId = pollSession.current + 1;
    pollSession.current = sessionId;
    void pollUntilSettled(sessionId);

    return () => {
      pollSession.current += 1;
    };
  }, [pollUntilSettled]);

  const triggerExport = useCallback(async () => {
    pollSession.current += 1; // 作废既有轮询
    setPhase("submitting");
    setMessage("");

    try {
      const response = await fetch("/api/privacy/export", {
        method: "POST",
        cache: "no-store",
      });

      if (response.status === 202) {
        setPhase("queued");
        setMessage("正在排队");
        startPolling();
        return;
      }

      if (response.status === 409) {
        // 已有 active 导出（双击/多 tab）：接续既有生命周期而非报错终止
        setPhase("generating");
        setMessage("已有一次导出正在进行");
        startPolling();
        return;
      }

      if (response.status === 429) {
        setPhase("idle");
        setMessage("导出过于频繁，请稍后再试");
        return;
      }

      if (response.status === 401) {
        setPhase("idle");
        setMessage("请先登录");
        return;
      }

      setPhase("idle");
      setMessage("申请失败，请稍后再试");
    } catch {
      setPhase("idle");
      setMessage("网络异常，请稍后再试");
    }
  }, [startPolling]);

  const busy = phase === "submitting" || phase === "queued" || phase === "generating";

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => void triggerExport()}
        disabled={busy}
        data-testid="export-data-trigger"
        className="rounded-full bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {busy ? "生成中..." : "导出我的数据（JSON）"}
      </button>

      <p className="text-xs text-slate-400" data-testid="export-hint">
        导出文件由后台异步生成，完成后可在此下载；文件短生命周期有效，到期自动删除。
      </p>

      {message ? (
        <p
          className={`text-sm ${phase === "failed" || phase === "expired" ? "text-rose-600" : "text-slate-600"}`}
          data-testid="export-status"
        >
          {message}
        </p>
      ) : null}

      {phase === "ready" && download ? (
        <div className="flex flex-wrap items-center gap-3">
          <a
            href={download.path}
            data-testid="export-download-link"
            className="rounded-full bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500"
          >
            下载导出文件
          </a>
          {download.expiresAt ? (
            <span className="text-xs text-slate-500" data-testid="export-expiry">
              下载有效期至 {formatExpiry(download.expiresAt)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 账号注销：typed confirmation（需输入"注销账号"）→ 同步执行。 */
export function DeleteAccountForm() {
  const [state, formAction] = useActionState(requestAccountDeletion, initialState);
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    if (state.signedOut) {
      const timer = setTimeout(() => {
        void signOut({ callbackUrl: "/" });
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [state.signedOut]);

  return (
    <form action={formAction} className="space-y-3">
      <p className="text-sm leading-6 text-slate-600">
        注销后你的账号将无法登录，个人可识别信息将被删除或匿名化；历史订单与评价将以
        “已注销用户”的匿名形式保留，以维持交易记录完整性。存在进行中交易或治理冻结时，
        注销会被阻止且不会部分删除数据。
      </p>
      <label className="flex flex-col gap-2 text-sm">
        输入“注销账号”以确认
        <input
          name="confirmation"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          placeholder="注销账号"
          autoComplete="off"
        />
      </label>
      <SubmitButton label="申请注销账号" danger />
      {state.message ? (
        <p
          className={`text-sm ${state.success ? "text-emerald-600" : "text-rose-600"}`}
          data-testid="deletion-result"
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export function CancelRequestForm({ requestId }: { requestId: string }) {
  const [state, formAction] = useActionState(cancelPrivacyRequest, initialState);

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="requestId" value={requestId} />
      <button
        type="submit"
        className="text-xs text-slate-500 underline-offset-2 transition hover:text-slate-900 hover:underline"
      >
        {state.message && !state.success ? state.message : "取消"}
      </button>
    </form>
  );
}
