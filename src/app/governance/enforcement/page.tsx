import Link from "next/link";

import { requireEnforcementReader } from "@/lib/enforcement/enforcement-read-access";
import { loadAuthorizedEnforcementQueue } from "@/lib/enforcement/enforcement-read-model";
import {
  ENFORCEMENT_REASON_LABELS,
  ENFORCEMENT_TYPE_LABELS,
} from "@/constants/governance";
import {
  decodeEnforcementSeqCursor,
  ENFORCEMENT_DEFAULT_PAGE_SIZE,
  enforcementPageLimitSchema,
  ENFORCEMENT_QUEUE_TARGET_TYPES,
  enforcementQueueQuerySchema,
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
 * Phase 7D 执法记录队列（/governance/enforcement，只读；§17/§10/§13 冻结）。
 *
 * - 排序 = enforcementSeq DESC（唯一因果权威）；createdAt 仅展示；
 * - seq 以 canonical decimal string 过 DTO/URL（R6 wire 合同）；
 * - scope 展示：scopeKey 权威（GLOBAL=全局；CAMPUS=校区；不一致行 fail
 *   closed 显示「范围记录不一致」安全 fallback，不修数据）；
 * - DTO 无 note / sourceId / 任意 metadata；previousState 仅折算为
 *   溯源完整性徽标（不作 current truth）；
 * - 7D 纯读：零 mutation 控件（处置仍只在 canonical 服务与既有面）。
 */
export default async function GovernanceEnforcementPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { access } = await requireEnforcementReader();
  const params = await searchParams;

  // 单值化：数组值视为无效（安全失败），仅接受标量查询参数；
  // 空串视为未填（GET 表单未填字段会以空串提交，不能触发筛选校验失败）
  const raw: Record<string, string> = {};
  let scalarOnly = true;
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      if (value !== "") {
        raw[key] = value;
      }
    } else {
      scalarOnly = false;
    }
  }

  const { limit: rawLimit, ...rest } = raw;
  let limit = ENFORCEMENT_DEFAULT_PAGE_SIZE;
  let queryInvalid = !scalarOnly;
  const parsedLimit =
    rawLimit === undefined ? undefined : enforcementPageLimitSchema.safeParse(rawLimit);
  if (parsedLimit === undefined) {
    // limit 缺席 → 默认
  } else if (parsedLimit.success) {
    limit = parsedLimit.data;
  }
  const parsedFilters = enforcementQueueQuerySchema.omit({ limit: true }).safeParse(rest);
  if (!parsedFilters.success || (parsedLimit !== undefined && !parsedLimit.success)) {
    queryInvalid = true;
  }

  let cursorInvalid = false;
  let cursor: bigint | undefined;
  if (!queryInvalid && parsedFilters.data!.cursor !== undefined) {
    const decoded = decodeEnforcementSeqCursor(parsedFilters.data!.cursor);
    if (decoded === null) {
      cursorInvalid = true;
    } else {
      cursor = decoded;
    }
  }

  const filters = parsedFilters.success
    ? {
        campusId: parsedFilters.data!.campusId,
        type: parsedFilters.data!.type,
        targetId: parsedFilters.data!.targetId,
        actorId: parsedFilters.data!.actorId,
        sourceType: parsedFilters.data!.sourceType,
      }
    : undefined;

  const page =
    cursorInvalid || queryInvalid
      ? { items: [], nextCursor: null }
      : await loadAuthorizedEnforcementQueue({ access, cursor, limit, filters });

  const nextSearchParams = new URLSearchParams();
  if (page.nextCursor) {
    nextSearchParams.set("cursor", page.nextCursor);
    for (const [key, value] of Object.entries(raw)) {
      if (key !== "cursor" && key !== "limit" && value !== "") {
        nextSearchParams.set(key, value);
      }
    }
    if (limit !== ENFORCEMENT_DEFAULT_PAGE_SIZE) {
      nextSearchParams.set("limit", String(limit));
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">执法记录</h1>
        <p className="mt-2 text-sm text-slate-600">
          执法动作的 append-only 溯源（who/what/whom/where/why/when，只读）。排序为因果序
          （enforcementSeq），时间列仅为展示。处置动作请使用各既有 canonical 面。
        </p>
      </div>

      <form
        aria-label="执法记录筛选"
        method="get"
        action="/governance/enforcement"
        className="mb-6 grid gap-3 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:grid-cols-2 lg:grid-cols-3"
      >
        <label className="text-xs font-medium text-slate-600">
          动作类型
          <select
            name="type"
            defaultValue={parsedFilters.data?.type ?? ""}
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          >
            <option value="">全部</option>
            {ENFORCEMENT_QUEUE_TARGET_TYPES.map((type) => (
              <option key={type} value={type}>
                {ENFORCEMENT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-600">
          目标用户 ID（targetId）
          <input
            name="targetId"
            defaultValue={parsedFilters.data?.targetId ?? ""}
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          执行者 ID（actorId）
          <input
            name="actorId"
            defaultValue={parsedFilters.data?.actorId ?? ""}
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          校区 ID（campusId）
          <input
            name="campusId"
            defaultValue={parsedFilters.data?.campusId ?? ""}
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          来源类型（sourceType）
          <input
            name="sourceType"
            defaultValue={parsedFilters.data?.sourceType ?? ""}
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
            placeholder="如 REPORT / MANUAL"
          />
        </label>
        <div className="flex items-end">
          <button
            type="submit"
            className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-slate-700"
          >
            应用筛选
          </button>
        </div>
      </form>

      {cursorInvalid || queryInvalid ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          {cursorInvalid ? "分页链接无效" : "筛选参数无效"}，请返回
          <Link href="/governance/enforcement" className="ml-1 text-slate-900 underline">
            执法记录首页
          </Link>
          重新进入。
        </div>
      ) : page.items.length === 0 ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          当前筛选条件下没有执法记录。
        </div>
      ) : (
        <div className="grid gap-4">
          {page.items.map((item) => (
            <article
              key={item.seq}
              className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-3">
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
              <div className="mt-3 space-y-1 text-sm text-slate-600">
                <p>
                  序号 #{item.seq} · 结果状态 {item.resultState}
                  {item.sourceType ? ` · 来源 ${item.sourceType}` : ""}
                </p>
                <p>
                  执行者：{item.actor.displayName} · 目标：{item.target.displayName}
                </p>
                <p>时间：{formatDateTime(item.createdAt)}</p>
              </div>
              <div className="mt-4">
                <Link
                  href={`/governance/enforcement/targets/${item.target.id}`}
                  className="inline-block rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                >
                  查看目标执法历史
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}

      {page.nextCursor ? (
        <div className="mt-6 flex justify-end">
          <Link
            href={`/governance/enforcement?${nextSearchParams.toString()}`}
            className="rounded-full border border-slate-200 bg-white px-5 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-950"
          >
            下一页
          </Link>
        </div>
      ) : null}
    </div>
  );
}
