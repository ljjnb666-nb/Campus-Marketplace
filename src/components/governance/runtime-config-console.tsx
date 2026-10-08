"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Building2, Globe2, History, ShieldCheck, SlidersHorizontal } from "lucide-react";

import {
  changeGovernanceRuntimeConfig, type RuntimeConfigActionState,
} from "@/actions/governance-runtime-config";
import type { EffectiveRuntimeConfig } from "@/lib/runtime-config/runtime-config-query";
import { RUNTIME_CONFIG_REGISTRY, type RuntimeConfigKey } from "@/lib/runtime-config/runtime-config-registry";

type OperatorConfig = {
  key: RuntimeConfigKey;
  scopeKey: string;
  currentValue: number | null;
  currentVersion: number;
  revisions: Array<{
    version: number; previousValue: number | null; newValue: number | null; createdAt: string;
  }>;
};

const labels: Record<EffectiveRuntimeConfig["source"], string> = {
  CAMPUS_OVERRIDE: "本校区显式配置",
  GLOBAL_OVERRIDE: "全平台配置",
  DEFAULT: "系统默认值",
  SAFE_FALLBACK: "保守安全回退值",
};
const initial: RuntimeConfigActionState = { status: "idle", message: "" };
const valueLabel = (value: number | null) => value === null ? "继承上级" : `${value} 条`;

export function RuntimeConfigConsole({
  config, effective, campusId, campusName, campuses, canManageGlobal,
}: {
  config: OperatorConfig;
  effective: EffectiveRuntimeConfig;
  campusId: string | null;
  campusName: string | null;
  campuses: { id: string; name: string }[];
  canManageGlobal: boolean;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(changeGovernanceRuntimeConfig, initial);
  const [mode, setMode] = useState<"set" | "inherit">("set");
  const [value, setValue] = useState(String(config.currentValue ?? RUNTIME_CONFIG_REGISTRY[config.key].defaultValue));
  const [confirm, setConfirm] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [syncedVersion, setSyncedVersion] = useState(config.currentVersion);
  const limits = RUNTIME_CONFIG_REGISTRY[config.key];

  // Server Action revalidatePath already refreshes the current route. Preserve
  // useActionState across that refresh so the success notice remains visible;
  // reconcile form inputs with the fresh CAS version before the next edit.
  // Guarded render-time adjustment avoids an extra effect-driven stale frame.
  if (syncedVersion !== config.currentVersion) {
    setSyncedVersion(config.currentVersion);
    setMode("set");
    setValue(String(config.currentValue ?? limits.defaultValue));
    setConfirm(false);
    setAcknowledged(false);
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="rounded-3xl bg-slate-950 p-6 text-white sm:p-9">
        <div className="mb-4 flex items-center gap-2 text-xs font-semibold tracking-wide text-indigo-200">
          <ShieldCheck className="size-4" aria-hidden="true" /> 治理控制台 / 配置权威
        </div>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">运行时配置中心</h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-300">
          管理已登记的非敏感参数。所有修改由服务端重新验证权限、检查版本并写入不可变修订与审计记录。
        </p>
        <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-slate-700 px-3 py-2 text-xs">
          {campusId === null ? <Globe2 className="size-4" aria-hidden="true" /> : <Building2 className="size-4" aria-hidden="true" />}
          {campusId === null ? "全平台" : campusName}
        </div>
      </header>

      <section aria-label="作用域选择" className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-lg font-semibold text-slate-950">管理范围</h2>
        <p className="mt-2 text-sm text-slate-600">校区设置优先于全局设置；继承状态不删除历史版本。</p>
        <form action="/governance/runtime-config" method="get" className="mt-4 flex flex-col gap-3 sm:flex-row">
          <label className="sr-only" htmlFor="runtime-config-campus">管理范围</label>
          <select id="runtime-config-campus" name="campusId" defaultValue={campusId ?? ""}
            className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm focus-visible:outline-2 focus-visible:outline-indigo-600">
            {canManageGlobal && <option value="">全平台 · GLOBAL</option>}
            {campuses.map(campus => <option key={campus.id} value={campus.id}>{campus.name}</option>)}
          </select>
          <button type="submit" className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800">
            切换范围
          </button>
        </form>
        {campuses.length >= 100 && <p className="mt-2 text-xs text-amber-800">仅列出前 100 个校区；其余授权校区可通过校区 ID 链接访问。</p>}
      </section>

      <section aria-label="已登记配置" className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold tracking-wide text-indigo-700">风控证据展示</p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">风险信号证据展示上限</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              控制风险情报中单次最多展示的原始信号条数；不会改变风险规则、账户限制或执法权威。
            </p>
          </div>
          <span className="rounded-full bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-800">
            当前生效：{effective.value} 条
          </span>
        </div>
        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl bg-slate-50 p-4"><dt className="text-slate-500">配置来源</dt><dd className="mt-2 font-semibold text-slate-900">{labels[effective.source]}</dd></div>
          <div className="rounded-2xl bg-slate-50 p-4"><dt className="text-slate-500">本范围覆盖</dt><dd className="mt-2 font-semibold text-slate-900">{config.currentVersion === 0 ? "尚未设置" : valueLabel(config.currentValue)}</dd></div>
          <div className="rounded-2xl bg-slate-50 p-4"><dt className="text-slate-500">当前版本</dt><dd className="mt-2 font-semibold text-slate-900">v{config.currentVersion}</dd></div>
          <div className="rounded-2xl bg-slate-50 p-4"><dt className="text-slate-500">允许范围</dt><dd className="mt-2 font-semibold text-slate-900">{limits.min}–{limits.max} 条</dd></div>
        </dl>
        {effective.source === "SAFE_FALLBACK" && (
          <p role="alert" className="mt-4 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            数据库或配置数据异常，当前显示保守回退值；请先检查系统状态，不要将其当作正常生效配置。
          </p>
        )}

        <form action={action} className="mt-6 border-t border-slate-100 pt-6">
          <input type="hidden" name="key" value={config.key} />
          <input type="hidden" name="campusId" value={campusId ?? ""} />
          <input type="hidden" name="expectedVersion" value={config.currentVersion} />
          <input type="hidden" name="nextValue" value={mode === "inherit" ? "inherit" : value} />
          <input type="hidden" name="acknowledgement" value={acknowledged ? "已确认配置影响" : ""} />

          <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <SlidersHorizontal className="size-4" aria-hidden="true" /> 修改配置
          </h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="runtime-mode" className="mb-2 block text-sm font-semibold text-slate-700">操作方式</label>
              <select id="runtime-mode" value={mode} disabled={confirm || pending}
                onChange={event => { setMode(event.target.value as "set" | "inherit"); setConfirm(false); setAcknowledged(false); }}
                className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm focus-visible:outline-2 focus-visible:outline-indigo-600">
                <option value="set">设置明确数值</option>
                {config.currentVersion > 0 && <option value="inherit">恢复继承</option>}
              </select>
            </div>
            <div>
              <label htmlFor="runtime-value" className="mb-2 block text-sm font-semibold text-slate-700">证据条数</label>
              <input id="runtime-value" type="number" min={limits.min} max={limits.max} step="1"
                disabled={mode === "inherit" || confirm || pending} value={value}
                onChange={event => { setValue(event.target.value); setConfirm(false); setAcknowledged(false); }}
                className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm focus-visible:outline-2 focus-visible:outline-indigo-600" />
            </div>
          </div>
          {!confirm ? (
            <button type="button" onClick={() => { setConfirm(true); setAcknowledged(false); }}
              className="mt-5 rounded-xl bg-indigo-700 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-800">
              预览变更
            </button>
          ) : (
            <div role="group" aria-label="配置变更确认" className="mt-5 rounded-2xl border border-indigo-200 bg-indigo-50/40 p-5">
              <h4 className="font-semibold text-slate-900">二次确认</h4>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                将「{campusId === null ? "全平台" : (campusName ?? "当前校区")}」的证据上限
                {mode === "inherit" ? "恢复继承上级配置" : `设置为 ${value} 条`}。
                以当前版本 v{config.currentVersion} 提交，版本变化时会拒绝覆盖。
              </p>
              <label className="mt-4 flex items-start gap-3 text-sm text-slate-700">
                <input type="checkbox" checked={acknowledged}
                  onChange={event => setAcknowledged(event.target.checked)}
                  className="mt-1 size-4 accent-indigo-700" />
                我已核对校区范围和风控显示影响，确认执行本次变更。
              </label>
              <div className="mt-4 flex flex-wrap gap-3">
                <button type="submit" disabled={!acknowledged || pending}
                  className="rounded-xl bg-indigo-700 px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">
                  {pending ? "提交中…" : "确认提交"}
                </button>
                <button type="button" disabled={pending}
                  onClick={() => { setConfirm(false); setAcknowledged(false); }}
                  className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700">
                  返回修改
                </button>
              </div>
            </div>
          )}
          {state.status !== "idle" && <p role={state.status === "success" ? "status" : "alert"}
            className={`mt-4 rounded-xl p-3 text-sm ${state.status === "success" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>
            {state.message}
            {state.status === "conflict" && <button type="button" onClick={() => router.refresh()} className="ml-2 font-semibold underline">刷新配置</button>}
          </p>}
        </form>
      </section>

      <section aria-label="配置修订历史" className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 sm:p-7">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-950"><History className="size-5" aria-hidden="true" />本范围最近的修订</h2>
        {config.revisions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">当前范围还没有修订历史。</p>
        ) : (
          <ol className="mt-4 divide-y divide-slate-100">
            {config.revisions.map(item => (
              <li key={item.version} className="flex flex-wrap gap-2 py-3 text-sm text-slate-700">
                <span className="font-semibold">v{item.version}</span>
                <span>{valueLabel(item.previousValue)} → {valueLabel(item.newValue)}</span>
                <time dateTime={item.createdAt} className="text-slate-500">
                  {new Date(item.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>
      <p className="mt-5 text-xs leading-6 text-slate-600">
        本页面仅开放运行时白名单中的非敏感配置；不包含密码、第三方密钥、支付参数、功能开关或自动处罚能力。
      </p>
    </main>
  );
}
