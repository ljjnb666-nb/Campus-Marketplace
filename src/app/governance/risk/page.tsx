import { notFound } from "next/navigation";

import { requireUser } from "@/lib/server-auth";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { deriveRiskReadAccess, hasAnyRiskReadAccess } from "@/lib/risk/risk-read-access";
import {
  loadAuthorizedRiskIntelligence,
  type RiskIntelligenceAssessment,
  type RiskMatchedRule,
  type RiskSignalEvidence,
} from "@/lib/risk/risk-intelligence";

export const dynamic = "force-dynamic";

// This screen is an advisory read surface. It has no operator mutation path,
// no user-directory access, no automatic enforcement and no numeric risk score.
const attentionLabels: Record<RiskIntelligenceAssessment["attentionLevel"], string> = {
  CLEAR: "无活跃信号",
  OBSERVE: "持续关注",
  REVIEW: "需要人工复核",
  PRIORITY_REVIEW: "优先人工复核",
};
const ruleLabels: Record<RiskMatchedRule["ruleId"], string> = {
  MANUAL_HIGH_SIGNAL: "人工高严重度信号",
  CONFIRMED_HIGH_SIGNAL: "确认举报：高严重度",
  CONFIRMED_REPORT_PRESENT: "存在已确认举报",
  MANUAL_REVIEW_SIGNAL: "人工中严重度信号",
  MANUAL_CONTEXT_SIGNAL: "人工上下文信号",
  UNCONFIRMED_REPORT_CONTEXT: "未核实举报（仅供参考）",
  DISPUTE_CONTEXT_ONLY: "租赁纠纷（仅供参考）",
};
const kindLabels: Record<RiskSignalEvidence["kind"], string> = {
  REPORT_SUBMITTED: "尚未核实的举报",
  REPORT_CONFIRMED: "已核实举报",
  RENTAL_DISPUTE_OPENED: "租赁纠纷",
  MANUAL_FLAG: "人工标记",
};
const severityLabels: Record<RiskSignalEvidence["severity"], string> = {
  INFO: "信息", LOW: "低", MEDIUM: "中", HIGH: "高",
};
const safeId = /^[a-zA-Z0-9_-]{1,128}$/;

function formatTime(iso: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * Phase 10I — independent risk.read leaf authorization.
 * The first scope check happens BEFORE the RiskFlag query, and the canonical
 * Phase 10D loader pushes campusId into both SQL queries.
 * No target existence lookup is performed: unknown ID and zero-signal ID
 * intentionally produce the same result.
 */
export default async function GovernanceRiskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireUser();
  const access = deriveRiskReadAccess(await loadAuthorizationContext(actor.id));
  if (!hasAnyRiskReadAccess(access)) notFound();

  const params = await searchParams;
  const unknownKeys = Object.keys(params).some(key => key !== "campusId" && key !== "targetUserId");
  const invalidShape =
    unknownKeys || Array.isArray(params.campusId) || Array.isArray(params.targetUserId);
  const rawCampus = typeof params.campusId === "string" ? params.campusId.trim() : "";
  const rawTarget = typeof params.targetUserId === "string" ? params.targetUserId.trim() : "";
  const invalidInput =
    invalidShape ||
    (rawCampus !== "" && !safeId.test(rawCampus)) ||
    (rawTarget !== "" && !safeId.test(rawTarget));

  // A campus-only reader can never silently broaden the scope to ALL_SCOPES.
  // An explicitly forged campus scope is denied even without a target ID.
  const campusId = access.global ? (rawCampus || undefined) : (rawCampus || access.campusIds[0]);
  if (!invalidInput && !access.global && !access.campusIds.includes(campusId!)) notFound();

  const assessment = !invalidInput && rawTarget
    ? await loadAuthorizedRiskIntelligence({
        access, targetUserId: rawTarget,
        ...(campusId === undefined ? {} : { campusId }),
      })
    : null;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-9 sm:px-6">
      <header className="rounded-3xl bg-slate-950 p-7 text-white sm:p-9">
        <p className="text-xs font-semibold tracking-wider text-indigo-200">治理控制台 / 风险情报</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">风险情报查询</h1>
        <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">
          仅显示风险信号与可解释规则建议，不是处罚结论。举报和纠纷需经人工核实；
          本页面不会修改用户、权限、风险限制或执法记录。
        </p>
      </header>

      <form method="get" action="/governance/risk" aria-label="风险情报查询条件"
        className="mt-6 grid gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:grid-cols-2">
        <label className="text-sm font-semibold text-slate-700">
          目标用户 ID
          <input name="targetUserId" maxLength={128} defaultValue={rawTarget}
            placeholder="输入用户 ID" autoComplete="off"
            className="mt-2 block w-full rounded-xl border border-slate-300 px-4 py-3 text-sm font-normal text-slate-950" />
        </label>
        {access.global ? (
          <label className="text-sm font-semibold text-slate-700">
            校区 ID（留空为全范围）
            <input name="campusId" maxLength={128} defaultValue={rawCampus}
              placeholder="留空：全范围，包含未归属校区信号" autoComplete="off"
              className="mt-2 block w-full rounded-xl border border-slate-300 px-4 py-3 text-sm font-normal text-slate-950" />
          </label>
        ) : (
          <label className="text-sm font-semibold text-slate-700">
            已授权校区
            <select name="campusId" defaultValue={campusId}
              className="mt-2 block w-full rounded-xl border border-slate-300 px-4 py-3 text-sm font-normal text-slate-950">
              {access.campusIds.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
        )}
        <div className="sm:col-span-2">
          <button type="submit" className="rounded-xl bg-indigo-700 px-6 py-3 text-sm font-semibold text-white hover:bg-indigo-800">
            查询风险信号
          </button>
        </div>
      </form>

      {invalidInput ? (
        <p role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-900">
          查询参数无效，未读取任何风险数据。请重新输入有效的用户 ID 和校区 ID。
        </p>
      ) : assessment === null ? (
        <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-8 text-sm leading-7 text-slate-600">
          输入目标用户 ID 开始查询。权限只允许查看已授权的校区信号；仅具备执法记录、审计或功能开关权限不能查看风险情报。
        </section>
      ) : (
        <div className="mt-6 space-y-6">
          <section aria-label="风险情报概览" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold text-indigo-700">规则集 v{assessment.rulesetVersion} · 只读建议</p>
                <h2 className="mt-2 text-2xl font-semibold text-slate-950">{attentionLabels[assessment.attentionLevel]}</h2>
                <p className="mt-2 text-sm text-slate-600">
                  {assessment.scope.kind === "ALL_SCOPES" ? "授权范围：全范围" : "授权校区：" + assessment.scope.campusId}
                </p>
              </div>
              <div className="rounded-2xl bg-slate-100 px-5 py-4 text-center">
                <p className="text-xs text-slate-600">活跃风险信号数</p>
                <p className="mt-1 text-3xl font-semibold tabular-nums text-slate-950">{assessment.activeSignalCount}</p>
              </div>
            </div>
            <p className="mt-5 text-sm leading-6 text-slate-600">
              规则结果不是用户风险评分或定罪依据。无活跃信号不能证明用户存在、身份可信或没有风险；
              人工复核与账号处置必须经独立授权流程。
            </p>
            <p className="mt-2 text-xs text-slate-500">查询时间：{formatTime(assessment.evaluatedAt)}（北京时间）</p>
          </section>

          <section aria-label="命中规则" className="rounded-3xl border border-slate-200 bg-white p-6 sm:p-8">
            <h2 className="text-xl font-semibold text-slate-950">命中规则</h2>
            {assessment.matchedRules.length === 0 ? (
              <p className="mt-3 text-sm text-slate-600">当前范围没有命中规则。</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {assessment.matchedRules.map(rule => (
                  <li key={rule.ruleId} className="flex flex-wrap justify-between gap-3 rounded-xl bg-slate-50 p-4 text-sm">
                    <span className="font-medium text-slate-800">{ruleLabels[rule.ruleId]}</span>
                    <span className="tabular-nums text-slate-600">{rule.signalCount} 条信号</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="风险信号证据" className="rounded-3xl border border-slate-200 bg-white p-6 sm:p-8">
            <h2 className="text-xl font-semibold text-slate-950">风险信号证据</h2>
            <p className="mt-2 text-sm text-slate-600">
              仅展示信号种类、严重度、来源类型、校区和时间。不展示举报备注、来源 ID、创建人或其他敏感内容。
            </p>
            {assessment.evidenceTruncated && (
              <p role="status" className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
                当前仅展示部分证据：受运行时证据条数上限约束，信号总数以概览为准。
              </p>
            )}
            {assessment.evidence.length === 0 ? (
              <p className="mt-4 text-sm text-slate-600">该范围没有可展示的活跃信号。</p>
            ) : (
              <ul className="mt-5 divide-y divide-slate-100">
                {assessment.evidence.map(item => (
                  <li key={item.signalId} className="grid gap-2 py-4 text-sm sm:grid-cols-3">
                    <span className="font-semibold text-slate-900">{kindLabels[item.kind]} · {severityLabels[item.severity]}</span>
                    <span className="text-slate-600">来源：{item.sourceType} · {item.campusId ?? "未归属校区"}</span>
                    <time dateTime={item.createdAt} className="text-slate-500 sm:text-right">{formatTime(item.createdAt)}</time>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
