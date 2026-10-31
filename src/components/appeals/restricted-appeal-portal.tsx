"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

type PunitiveType = "ACCOUNT_SUSPEND" | "MEMBERSHIP_SUSPEND" | "MARKETPLACE_RESTRICT";
type EligibleItem = {
  enforcementActionId: string;
  type: PunitiveType;
  scopeKind: "GLOBAL" | "CAMPUS";
  createdAt: string;
  appeal: { id: string; status: string } | null;
};
type EligiblePage = { items: EligibleItem[]; nextCursor: string | null };
type ViewStatus = "loading" | "ready" | "unauthorized" | "error";

const LABELS: Record<PunitiveType, string> = {
  ACCOUNT_SUSPEND: "账号限制",
  MEMBERSHIP_SUSPEND: "校区成员资格限制",
  MARKETPLACE_RESTRICT: "集市使用限制",
};

function isEligiblePage(data: unknown): data is EligiblePage {
  if (!data || typeof data !== "object") return false;
  const page = data as Record<string, unknown>;
  if (!Array.isArray(page.items) ||
      (page.nextCursor !== null && typeof page.nextCursor !== "string")) return false;
  return page.items.every((item: unknown) => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    const appeal = row.appeal;
    return typeof row.enforcementActionId === "string" &&
      typeof row.type === "string" && Object.prototype.hasOwnProperty.call(LABELS, row.type) &&
      (row.scopeKind === "GLOBAL" || row.scopeKind === "CAMPUS") &&
      typeof row.createdAt === "string" &&
      (appeal === null ||
        (typeof appeal === "object" && appeal !== null &&
         typeof (appeal as Record<string, unknown>).id === "string" &&
         typeof (appeal as Record<string, unknown>).status === "string"));
  });
}

type FetchResult = { kind: "unauthorized" } | { kind: "ready"; page: EligiblePage };

// Pure I/O: do not mutate component state. It is safe to start this promise
// in a mount effect; state is updated only from its settled async handlers.
async function readEligiblePage(next?: string): Promise<FetchResult> {
  const params = new URLSearchParams({ limit: "25" });
  if (next) params.set("cursor", next);
  const response = await fetch("/api/appeals/eligible-actions?" + params.toString(), {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) return { kind: "unauthorized" };
  if (!response.ok) throw new Error("appeal list unavailable");
  const page: unknown = await response.json();
  if (!isEligiblePage(page)) throw new Error("invalid appeal page");
  return { kind: "ready", page };
}

/**
 * No private server props, role bypass or raw enforcement record access.
 * All identity/ownership comes from /api/appeals/**; the public shell leaks
 * neither the existence of a particular account nor suspension status.
 */
export function RestrictedAppealPortal() {
  const [items, setItems] = useState<EligibleItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [view, setView] = useState<ViewStatus>("loading");
  const [selected, setSelected] = useState<string | null>(null);
  const [statement, setStatement] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState("");

  const load = useCallback(async (next?: string) => {
    try {
      const result = await readEligiblePage(next);
      if (result.kind === "unauthorized") {
        setItems([]);
        setCursor(null);
        setView("unauthorized");
        return;
      }
      setItems(previous => next ? [...previous, ...result.page.items] : result.page.items);
      setCursor(result.page.nextCursor);
      setView("ready");
    } catch {
      setView("error");
    }
  }, []);

  useEffect(() => {
    // A request started from an effect may only commit state from settled
    // async callbacks. Avoid calling the state-mutating load() synchronously.
    let active = true;
    void readEligiblePage().then(result => {
      if (!active) return;
      if (result.kind === "unauthorized") {
        setItems([]);
        setCursor(null);
        setView("unauthorized");
      } else {
        setItems(result.page.items);
        setCursor(result.page.nextCursor);
        setView("ready");
      }
    }).catch(() => {
      if (active) setView("error");
    });
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !statement.trim() || statement.trim().length > 2000 || submitting) return;
    const item = items.find(x => x.enforcementActionId === selected);
    if (!item || item.appeal) return;
    setSubmitting(true);
    setFeedback("");
    try {
      const response = await fetch("/api/appeals", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enforcementActionId: selected, statement: statement.trim() }),
      });
      if (!response.ok) {
        setFeedback(response.status === 401
          ? "当前会话无法申诉，请重新登录。"
          : "申诉未提交，请刷新可申诉记录后重试。");
        return;
      }
      if (response.status !== 201) {
        setFeedback("申诉状态无法确认，请刷新记录核实后再操作。");
        return;
      }
      setSelected(null);
      setStatement("");
      setFeedback("申诉已提交，可在下方查看最新状态。");
      await load();
    } catch {
      setFeedback("网络异常，申诉状态未确认。请先刷新记录，避免重复提交。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-6">
      <h2 className="text-xl font-semibold text-slate-900">本人可申诉记录</h2>
      <p className="mt-2 text-sm text-slate-600">
        此处只展示既有申诉接口允许的本人记录，不提供其他业务数据。
      </p>
      {view === "loading" && items.length === 0 ? <p role="status" className="mt-4 text-sm">正在核验会话并读取记录…</p> : null}
      {view === "unauthorized" ? (
        <p role="status" className="mt-4 text-sm text-amber-800">
          当前无法验证申诉会话。请先<Link className="underline" href="/login">登录</Link>，
          再返回此页面。不会在此披露账号限制原因。
        </p>
      ) : null}
      {view === "error" ? (
        <div className="mt-4 text-sm text-red-700" role="alert">
          申诉记录暂时无法读取。
          <button type="button" onClick={() => { setView("loading"); void load(); }} className="ml-2 underline">重新查询</button>
        </div>
      ) : null}
      {view === "ready" && items.length === 0 ? (
        <p role="status" className="mt-4 text-sm text-slate-600">当前没有可申诉的处罚记录。</p>
      ) : null}
      {view === "ready" && items.length > 0 ? (
        <ul className="mt-5 space-y-4">
          {items.map(item => (
            <li key={item.enforcementActionId} className="rounded-2xl border border-slate-200 p-4">
              <p className="font-medium text-slate-900">{LABELS[item.type]}</p>
              <p className="mt-1 text-xs text-slate-500">
                {item.scopeKind === "GLOBAL" ? "平台范围" : "校区范围"} · {new Date(item.createdAt).toLocaleDateString("zh-CN")}
              </p>
              {item.appeal ? (
                <p className="mt-2 text-sm text-slate-600">
                  已有申诉，状态：{item.appeal.status === "SUBMITTED" ? "已提交"
                    : item.appeal.status === "IN_REVIEW" ? "审核中"
                    : item.appeal.status === "GRANTED" ? "申诉通过"
                    : item.appeal.status === "UPHELD" ? "维持原处理"
                    : item.appeal.status === "DISMISSED" ? "程序性驳回"
                    : item.appeal.status === "WITHDRAWN" ? "已撤回" : "请以系统记录为准"}
                </p>
              ) : (
                <button type="button"
                  className="mt-3 rounded-full border border-slate-300 px-4 py-2 text-sm"
                  onClick={() => { setSelected(item.enforcementActionId); setStatement(""); setFeedback(""); }}>
                  为此项处罚提交申诉
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {view === "ready" && cursor ? (
        <button type="button" className="mt-4 text-sm underline" onClick={() => { void load(cursor); }}>加载更多</button>
      ) : null}
      {selected && view === "ready" ? (
        <form className="mt-6 space-y-3" onSubmit={submit} aria-label="提交账号申诉">
          <label htmlFor="appeal-statement" className="block text-sm font-medium">申诉说明</label>
          <textarea id="appeal-statement" value={statement}
            onChange={event => setStatement(event.target.value)}
            maxLength={2000} required rows={5}
            className="w-full rounded-xl border border-slate-300 p-3 text-sm"
            placeholder="请说明申诉理由，勿填写密码或其他敏感凭据。" />
          <div className="flex gap-3">
            <button type="submit" disabled={submitting || statement.trim().length === 0}
              className="rounded-full bg-slate-950 px-4 py-2 text-sm text-white disabled:opacity-50">
              {submitting ? "提交中…" : "提交申诉"}
            </button>
            <button type="button" className="text-sm underline"
              onClick={() => { setSelected(null); setStatement(""); }}>取消</button>
          </div>
        </form>
      ) : null}
      {feedback ? <p className="mt-4 text-sm" role="status">{feedback}</p> : null}
    </section>
  );
}
