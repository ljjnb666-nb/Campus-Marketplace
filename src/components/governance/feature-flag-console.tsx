"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity, AlertTriangle, ArrowRight, Building2, CheckCircle2, CircleHelp,
  Clock3, Globe2, LockKeyhole, PauseCircle, ShieldAlert,
  SlidersHorizontal,
} from "lucide-react";

import {
  changeGovernanceFeatureFlag,
  type FeatureFlagActionState,
} from "@/actions/governance-feature-flags";
import type { FeatureFlagConsoleRow } from "@/lib/feature-flags/feature-flag-ui-query";
import type { FeatureFlagKey } from "@/lib/feature-flags/feature-flag-registry";

type NextValue = "true" | "false" | "inherit";

const DETAILS: Record<FeatureFlagKey, { name: string; description: string; group: string; caution?: string }> = {
  DISABLE_REGISTRATION: {
    name: "新用户注册", group: "访问与准入",
    description: "暂停新账号注册，不会停用已经存在的账号。",
  },
  DISABLE_NEW_LISTINGS: {
    name: "发布新商品及服务", group: "交易活动",
    description: "阻止发布商品、租赁、技能服务及跑腿任务；不妨碍编辑已有信息。",
  },
  DISABLE_NEW_ORDERS: {
    name: "发起新订单", group: "交易活动",
    description: "暂停创建新订单；在途交易的履约、取消和归还不受影响。",
  },
  DISABLE_NEW_CONVERSATIONS: {
    name: "创建新会话", group: "交流互动",
    description: "不允许开启全新聊天会话；既有会话不被删除。",
  },
  DISABLE_NEW_MESSAGES: {
    name: "发送新消息", group: "交流互动",
    description: "暂停发送新消息；历史记录仍然保留。",
  },
  DISABLE_MEETUPS: {
    name: "提出新见面安排", group: "交易活动",
    description: "阻止提出新的面交约定；既有面交义务保持。",
  },
  DISABLE_DISPUTE_INITIATION: {
    name: "发起新纠纷", group: "安全与应急",
    description: "仅暂停新纠纷发起；既有纠纷的受理和处理继续开放。",
    caution: "高风险：关闭纠纷入口前，必须确认替代客服通道已畅通，并记录应急处置原因。",
  },
  MAINTENANCE_MODE: {
    name: "平台维护模式", group: "安全与应急",
    description: "暂停新活动及公开列表编辑；安全、申诉、归还及恢复流程继续可用。",
    caution: "影响面广：确认维护窗口与用户告知计划后再操作。",
  },
  READ_ONLY_MODE: {
    name: "只读保护模式", group: "安全与应急",
    description: "停止新活动与公开内容修改，但不会阻断已有义务的履行和恢复。",
    caution: "影响面广：启用后所有校区或目标校区的新交易活动会被限制。",
  },
};

const GROUPS = ["安全与应急", "交易活动", "交流互动", "访问与准入"];

function nextLabel(value: NextValue): string {
  return value === "true" ? "暂停此功能" : value === "false" ? "允许此功能" : "继承平台默认";
}
function stateLabel(value: boolean | null): string {
  return value === true ? "暂停" : value === false ? "允许" : "继承";
}
function localLabel(row: FeatureFlagConsoleRow): string {
  return row.currentVersion === 0
    ? "未设置覆盖"
    : row.localDisabled === null ? "继承上级" : row.localDisabled ? "明确暂停" : "明确允许";
}
const initial: FeatureFlagActionState = { status: "idle", message: "" };

function FlagCard({ row, campusId }: { row: FeatureFlagConsoleRow; campusId: string | null }) {
  const router = useRouter();
  const [state, action, isPending] = useActionState(changeGovernanceFeatureFlag, initial);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [value, setValue] = useState<NextValue>(row.localDisabled === true ? "false" : "true");
  const detail = DETAILS[row.key];

  useEffect(() => {
    if (state.status === "success") {
      setConfirming(false);
      setEditing(false);
      router.refresh();
    }
  }, [state.status, state.message, router]);

  return (
    <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold tracking-tight text-slate-950">{detail.name}</h3>
            <span className={row.effectiveDisabled
              ? "rounded-full bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700"
              : "rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700"}>
              {row.effectiveDisabled ? "已暂停" : "可使用"}
            </span>
          </div>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">{detail.description}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <span>当前作用域：{localLabel(row)}</span>
            <span aria-hidden="true">·</span>
            <span>配置版本 v{row.currentVersion}</span>
          </div>
          {campusId !== null && row.globalDisabled && (
            <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              平台全局已暂停此功能；即使本校区设置「允许」，也无法覆盖全局限制。
            </p>
          )}
          {detail.caution && (
            <p className="mt-3 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {detail.caution}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => { setEditing(!editing); setConfirming(false); setAcknowledged(false); }}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
          aria-expanded={editing}
          aria-label={`修改${detail.name}配置`}
        >
          <SlidersHorizontal className="size-4" aria-hidden="true" />
          {editing ? "收起配置" : "修改配置"}
        </button>
      </div>

      {editing && (
        <form action={action} className="mt-5 space-y-4 border-t border-slate-100 pt-5">
          <input type="hidden" name="key" value={row.key} />
          <input type="hidden" name="campusId" value={campusId ?? ""} />
          <input type="hidden" name="expectedVersion" value={row.currentVersion} />
          <input type="hidden" name="nextValue" value={value} />
          <input type="hidden" name="acknowledgement" value={acknowledged ? "已确认影响范围" : ""} />
          <label className="block text-sm font-semibold text-slate-800" htmlFor={`value-${row.key}`}>
            变更为
          </label>
          <select
            id={`value-${row.key}`}
            value={value}
            disabled={confirming || isPending}
            onChange={(event) => setValue(event.target.value as NextValue)}
            className="block w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-indigo-600 sm:max-w-sm"
          >
            <option value="true">暂停新活动</option>
            <option value="false">允许新活动</option>
            {row.currentVersion > 0 && <option value="inherit">恢复继承设置</option>}
          </select>
          {!confirming ? (
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
              onClick={() => { setConfirming(true); setAcknowledged(false); }}
            >
              预览变更 <ArrowRight className="size-4" aria-hidden="true" />
            </button>
          ) : (
            <div className="space-y-4 rounded-2xl border border-indigo-200 bg-indigo-50/50 p-4 sm:p-5" role="group" aria-label={`${detail.name}变更确认`}>
              <div className="flex items-center gap-2 font-semibold text-slate-950">
                <LockKeyhole className="size-4 text-indigo-700" aria-hidden="true" />
                二次确认
              </div>
              <p className="text-sm leading-6 text-slate-700">
                即将把「{detail.name}」在「{campusId === null ? "全平台" : "当前校区"}」设置为
                <strong className="px-1 text-indigo-800">{nextLabel(value)}</strong>。
                系统会检查最新权限和版本，并记录不可变审计历史。
              </p>
              {value === "false" && row.globalDisabled && campusId !== null &&
                <p className="text-sm font-semibold text-amber-800">注意：全局仍为暂停，本次允许不会立即生效。</p>}
              <label className="flex cursor-pointer items-start gap-3 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  className="mt-1 size-4 rounded border-slate-300 accent-indigo-700"
                />
                我已核对作用范围和对在途服务的影响，确认执行本次变更。
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  disabled={!acknowledged || isPending}
                  className="rounded-xl bg-indigo-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isPending ? "提交中…" : "确认提交"}
                </button>
                <button type="button" disabled={isPending}
                  onClick={() => { setConfirming(false); setAcknowledged(false); }}
                  className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700">
                  返回修改
                </button>
              </div>
            </div>
          )}
          {state.status !== "idle" && (
            <p role={state.status === "success" ? "status" : "alert"}
              className={`rounded-xl px-3 py-2 text-sm ${state.status === "success" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>
              {state.message}
              {state.status === "conflict" &&
                <button type="button" onClick={() => router.refresh()} className="ml-2 font-semibold underline">刷新配置</button>}
            </p>
          )}
        </form>
      )}

      <details className="mt-5 border-t border-slate-100 pt-4">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-semibold text-slate-600 hover:text-slate-900 [&::-webkit-details-marker]:hidden">
          <Clock3 className="size-4" aria-hidden="true" />
          查看本作用域变更记录（最近 {row.revisions.length} 条）
        </summary>
        {row.revisions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">暂无历史变更记录。</p>
        ) : (
          <ol className="mt-4 space-y-3 border-l border-slate-200 pl-4">
            {row.revisions.map((item) => (
              <li key={item.version} className="text-xs leading-5 text-slate-600">
                <span className="font-semibold text-slate-800">v{item.version}</span>
                <span className="mx-2">·</span>
                {stateLabel(item.previousDisabled)} → {stateLabel(item.nextDisabled)}
                <span className="ml-2 text-slate-500">{new Date(item.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</span>
              </li>
            ))}
          </ol>
        )}
      </details>
    </article>
  );
}

export function FeatureFlagConsole({
  rows, campusId, campusName, campuses, canManageGlobal,
}: {
  rows: FeatureFlagConsoleRow[];
  campusId: string | null;
  campusName: string | null;
  campuses: { id: string; name: string }[];
  canManageGlobal: boolean;
}) {
  const paused = rows.filter(row => row.effectiveDisabled).length;
  const overridden = rows.filter(row => row.currentVersion > 0 && row.localDisabled !== null).length;
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-8 overflow-hidden rounded-3xl bg-slate-950 px-6 py-8 text-white sm:px-9 sm:py-10">
        <div className="mb-4 flex items-center gap-2 text-xs font-semibold tracking-widest text-indigo-200">
          <ShieldAlert className="size-4" aria-hidden="true" />
          治理控制台 / 运行安全
        </div>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">功能开关与应急熔断</h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-300">
          控制新活动的准入范围。所有变更由服务端复核权限、校验版本并留存审计记录；
          不会自动中断已经发生的订单、申诉或归还流程。
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-2 text-xs text-slate-200">
          <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 px-3 py-1.5">
            {campusId === null ? <Globe2 className="size-3.5" aria-hidden="true" /> : <Building2 className="size-3.5" aria-hidden="true" />}
            {campusId === null ? "全平台" : campusName}
          </span>
          <span className="rounded-full border border-slate-700 px-3 py-1.5">仅对授权范围有效</span>
        </div>
      </div>

      <section aria-label="作用域选择" className="mb-7 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex items-start gap-3">
          <Globe2 className="mt-0.5 size-5 text-indigo-700" aria-hidden="true" />
          <div>
            <h2 className="font-semibold text-slate-950">选择管理范围</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              全平台暂停优先于校区的允许设置；切换范围后重新从数据库读取当前配置。
            </p>
          </div>
        </div>
        <form method="get" action="/governance/feature-flags" className="mt-4 flex flex-col gap-3 sm:flex-row">
          <label className="sr-only" htmlFor="flag-scope">管理范围</label>
          <select id="flag-scope" name="campusId" defaultValue={campusId ?? ""}
            className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-indigo-600">
            {canManageGlobal && <option value="">全平台 · GLOBAL</option>}
            {campuses.map(campus => <option key={campus.id} value={campus.id}>{campus.name}</option>)}
          </select>
          <button type="submit" className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800">
            切换范围
          </button>
        </form>
        {campuses.length >= 100 && <p className="mt-3 text-xs text-amber-700">校区列表仅展示前 100 项；更多校区可使用带校区 ID 的管理链接。</p>}
      </section>

      <section aria-label="开关概况" className="mb-9 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
          <div className="flex items-center gap-2 text-xs text-slate-500"><Activity className="size-4" aria-hidden="true"/> 已登记开关</div>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{rows.length}</p>
        </div>
        <div className="rounded-2xl border border-rose-100 bg-rose-50/60 p-4 sm:p-5">
          <div className="flex items-center gap-2 text-xs text-rose-700"><PauseCircle className="size-4" aria-hidden="true"/> 当前暂停</div>
          <p className="mt-2 text-3xl font-semibold text-rose-800">{paused}</p>
        </div>
        <div className="col-span-2 rounded-2xl border border-slate-200 bg-white p-4 sm:col-span-1 sm:p-5">
          <div className="flex items-center gap-2 text-xs text-slate-500"><CheckCircle2 className="size-4" aria-hidden="true"/> 本范围显式配置</div>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{overridden}</p>
        </div>
      </section>

      {GROUPS.map(group => {
        const scoped = rows.filter(row => DETAILS[row.key].group === group);
        if (!scoped.length) return null;
        return (
          <section key={group} aria-label={group} className="mb-9">
            <div className="mb-4 flex items-center gap-3">
              <h2 className="text-lg font-semibold tracking-tight text-slate-950">{group}</h2>
              <span className="text-xs text-slate-400">{scoped.length} 项</span>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {scoped.map(row => <FlagCard key={`${row.key}:${row.currentVersion}`} row={row} campusId={campusId} />)}
            </div>
          </section>
        );
      })}

      <aside className="flex gap-3 rounded-2xl border border-slate-200 bg-slate-100/60 p-5 text-sm leading-6 text-slate-600">
        <CircleHelp className="mt-0.5 size-5 shrink-0 text-slate-500" aria-hidden="true"/>
        <p>
          本页仅管理已登记的九个应急开关。关闭开关不代表已完成生产事故处置；
          高风险变更请同步执行运营预案。配置过期会被版本保护拒绝，不能覆盖他人的最新修改。
        </p>
      </aside>
    </main>
  );
}
