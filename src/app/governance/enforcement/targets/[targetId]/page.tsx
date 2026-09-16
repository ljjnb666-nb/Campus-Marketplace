import { notFound } from "next/navigation";

import { requireEnforcementReader } from "@/lib/enforcement/enforcement-read-access";
import {
  hasVisibleTargetAnchor,
  loadTargetEnforcementHistory,
  loadTargetRiskStateSummary,
} from "@/lib/enforcement/enforcement-read-model";
import { hydrateSafeIdentities } from "@/lib/governance/safe-identity";
import { ENFORCEMENT_REASON_LABELS, ENFORCEMENT_TYPE_LABELS, RISK_STATE_LABELS } from "@/constants/governance";
import {
  decodeEnforcementSeqCursor,
  ENFORCEMENT_DEFAULT_PAGE_SIZE,
  enforcementPageLimitSchema,
  enforcementTargetHistoryQuerySchema,
} from "@/validators/enforcement";

export const dynamic = "force-dynamic";

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/**
 * Phase 7D 执法目标详情（/governance/enforcement/targets/[targetId]，只读）。
 *
 * 存在性权威（R5 / DECISION_13 冻结顺序）：
 *   1. require active actor → 2. deriveEnforcementReadAccess
 *   → 3. 查询可见 anchor（AUTHORIZED EnforcementAction OR RiskState，
 *   DB 级 scope 谓词）→ 4. 零 anchor → notFound()
 *   → 5. anchor 存在后才水合目标身份。
 * User 绝不作为第一 existence query；无 anchor 的既有用户不产生空详情页；
 * 缺失用户与未授权目标统一 notFound（无存在性 oracle）。
 *
 * 历史为 bounded keyset（enforcementSeq ASC，25/50，take limit+1）——绝不
 * findMany(all history)；RiskState 仅 current summary（不考古，无合成行）。
 * 7D 纯读：零 mutation 控件。
 */
export default async function GovernanceEnforcementTargetPage({
  params,
  searchParams,
}: {
  params: Promise<{ targetId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { access } = await requireEnforcementReader();
  const { targetId } = await params;

  // 3/4/5：anchor 存在性先于任何身份水合
  const anchored = await hasVisibleTargetAnchor({ access, targetId });
  if (!anchored) {
    notFound();
  }

  const identities = await hydrateSafeIdentities([targetId]);
  const target = identities.get(targetId)!;

  const queryParams = await searchParams;
  const rawQuery: Record<string, string> = {};
  let queryInvalid = false;
  for (const [key, value] of Object.entries(queryParams)) {
    if (typeof value === "string") {
      // 空串视为未填（与 queue 页同语义）
      if (value !== "") {
        rawQuery[key] = value;
      }
    } else {
      queryInvalid = true;
    }
  }

  const parsed = enforcementTargetHistoryQuerySchema.safeParse(rawQuery);
  let limit = ENFORCEMENT_DEFAULT_PAGE_SIZE;
  if (parsed.success && parsed.data.limit !== undefined) {
    limit = enforcementPageLimitSchema.parse(parsed.data.limit);
  }
  if (!parsed.success) {
    queryInvalid = true;
  }

  let cursorInvalid = false;
  let cursor: bigint | undefined;
  if (!queryInvalid && parsed.success && parsed.data.cursor !== undefined) {
    const decoded = decodeEnforcementSeqCursor(parsed.data.cursor);
    if (decoded === null) {
      cursorInvalid = true;
    } else {
      cursor = decoded;
    }
  }

  const history =
    cursorInvalid || queryInvalid
      ? { items: [], nextCursor: null }
      : await loadTargetEnforcementHistory({ access, targetId, cursor, limit });
  const riskStates = await loadTargetRiskStateSummary({ access, targetId });

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <p className="text-sm text-slate-500">
          <a href="/governance/enforcement" className="text-slate-600 underline">
            ← 返回执法记录
          </a>
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-950">
          目标执法历史：{target.displayName}
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          因果序（enforcementSeq 升序）展示的完整历史切片（每页最多 50 条）；
          当前限制状态以 canonical projection（RiskState）为准。
        </p>
      </div>

      <section aria-label="当前限制状态" className="mb-8">
        <h2 className="mb-3 text-lg font-semibold text-slate-950">当前限制状态</h2>
        {riskStates.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-6 text-sm text-slate-500">
            当前授权范围内没有该目标的风险状态记录。
          </div>
        ) : (
          <div className="grid gap-3">
            {riskStates.map((state) => (
              <div
                key={state.scopeKey}
                className="flex flex-wrap items-center gap-3 rounded-[20px] border border-slate-200 bg-white p-4 shadow-sm"
              >
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    state.state === "RESTRICTED"
                      ? "bg-red-100 text-red-800"
                      : state.state === "WATCH"
                        ? "bg-amber-100 text-amber-800"
                        : "bg-emerald-100 text-emerald-800"
                  }`}
                >
                  {RISK_STATE_LABELS[state.state]}
                </span>
                <span className="text-xs font-medium text-slate-700">{state.scopeKey}</span>
                {state.campusName ? (
                  <span className="text-xs text-slate-500">校区：{state.campusName}</span>
                ) : null}
                {state.reasonCode ? (
                  <span className="text-xs text-slate-500">
                    原因码：{ENFORCEMENT_REASON_LABELS[
                      state.reasonCode as keyof typeof ENFORCEMENT_REASON_LABELS
                    ] ?? state.reasonCode}
                  </span>
                ) : null}
                {state.updatedBy ? (
                  <span className="text-xs text-slate-500">
                    最近操作：{state.updatedBy.displayName}
                  </span>
                ) : null}
                <span className="text-xs text-slate-500">
                  {formatDateTime(state.updatedAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-label="执法历史">
        <h2 className="mb-3 text-lg font-semibold text-slate-950">执法历史（因果序）</h2>
        {cursorInvalid || queryInvalid ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            {cursorInvalid ? "分页链接无效" : "查询参数无效"}，请返回
            <a href="/governance/enforcement" className="ml-1 text-slate-900 underline">
              执法记录
            </a>
            重新进入。
          </div>
        ) : history.items.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-6 text-sm text-slate-500">
            没有更多历史记录。
          </div>
        ) : (
          <div className="grid gap-3">
            {history.items.map((item) => (
              <article
                key={item.seq}
                className="rounded-[20px] border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs font-semibold text-slate-950">#{item.seq}</span>
                  <span className="rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white">
                    {ENFORCEMENT_TYPE_LABELS[item.type]}
                  </span>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    {item.scope === "GLOBAL"
                      ? "全局"
                      : item.scope === "CAMPUS"
                        ? `校区：${item.campusName ?? "未知校区"}`
                        : "范围记录不一致"}
                  </span>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    原因：{ENFORCEMENT_REASON_LABELS[item.reasonCode]}
                  </span>
                  {item.legacyEpoch ? (
                    <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
                      迁移前记录
                    </span>
                  ) : null}
                  {!item.provenanceComplete ? (
                    <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
                      溯源不完整
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 space-y-1 text-sm text-slate-600">
                  <p>
                    执行者：{item.actor.displayName} · 结果状态 {item.resultState}
                  </p>
                  <p>时间：{formatDateTime(item.createdAt)}</p>
                </div>
              </article>
            ))}
          </div>
        )}

        {history.nextCursor ? (
          <div className="mt-6 flex justify-end">
            <a
              href={`/governance/enforcement/targets/${targetId}?cursor=${encodeURIComponent(
                history.nextCursor,
              )}${limit !== ENFORCEMENT_DEFAULT_PAGE_SIZE ? `&limit=${limit}` : ""}`}
              className="rounded-full border border-slate-200 bg-white px-5 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-950"
            >
              下一页
            </a>
          </div>
        ) : null}
      </section>
    </div>
  );
}
