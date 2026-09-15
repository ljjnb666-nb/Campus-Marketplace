import Link from "next/link";

import { requireAuditReader } from "@/lib/audit/audit-access";
import { loadAuthorizedAuditPage } from "@/lib/audit/audit-read-model";
import {
  AUDIT_DEFAULT_PAGE_SIZE,
  auditPageLimitSchema,
  auditQueueQuerySchema,
  decodeAuditCursor,
  type AuditCursor,
} from "@/validators/audit";

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
 * Phase 7D 审计日志队列（/governance/audit，QUEUE_ONLY——无 [id] 详情路由）。
 *
 * 冻结合同（Planning DECISION_02A/03/11）：
 * - 授权在 DB 谓词内（audit read model）；invalid cursor / 无效筛选 →
 *   安全失败态（不泄露数据、不回退首页）；
 * - DTO 无 AdminLog.detail（结构性不 select）；metadata 仅经读侧披露投影
 *   的 {label, value} 结构化条目，raw object 永不进组件；
 * - campusId=null 行展示「无校区归属记录」（NO_CAMPUS_SCOPE_RECORDED），
 *   绝不显示「全局操作」——null 混有 legacy/写入缺口，无独立 scope 权威；
 * - 7D 纯读：零 mutation 控件。
 */
export default async function GovernanceAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { access } = await requireAuditReader();
  const params = await searchParams;

  // 单值化：数组值视为无效（安全失败），仅接受标量查询参数
  const raw: Record<string, string> = {};
  let scalarOnly = true;
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      raw[key] = value;
    } else {
      scalarOnly = false;
    }
  }

  // limit 宽松（7A 同款：非法静默回退默认）；其余筛选严格（无效 → 安全失败）
  const { limit: rawLimit, ...rest } = raw;
  let limit = AUDIT_DEFAULT_PAGE_SIZE;
  let queryInvalid = !scalarOnly;
  const parsedLimit =
    rawLimit === undefined ? undefined : auditPageLimitSchema.safeParse(rawLimit);
  if (parsedLimit === undefined) {
    // limit 缺席 → 默认
  } else if (parsedLimit.success) {
    limit = parsedLimit.data;
  }
  const parsedFilters = auditQueueQuerySchema.omit({ limit: true }).safeParse(rest);
  if (!parsedFilters.success || (parsedLimit !== undefined && !parsedLimit.success)) {
    queryInvalid = true;
  }

  let cursorInvalid = false;
  let cursor: AuditCursor | undefined;
  if (!queryInvalid && parsedFilters.data!.cursor !== undefined) {
    const decoded = decodeAuditCursor(parsedFilters.data!.cursor);
    if (!decoded) {
      cursorInvalid = true;
    } else {
      cursor = decoded;
    }
  }

  const filters = parsedFilters.success
    ? {
        campusId: parsedFilters.data!.campusId,
        actorId: parsedFilters.data!.actorId,
        targetType: parsedFilters.data!.targetType,
        action: parsedFilters.data!.action,
        from: parsedFilters.data!.from,
        to: parsedFilters.data!.to,
      }
    : undefined;

  const page =
    cursorInvalid || queryInvalid
      ? { items: [], nextCursor: null }
      : await loadAuthorizedAuditPage({ access, cursor, limit, filters });

  // 下一页链接保持当前筛选
  const nextSearchParams = new URLSearchParams();
  if (page.nextCursor) {
    nextSearchParams.set("cursor", page.nextCursor);
    for (const [key, value] of Object.entries(raw)) {
      if (key !== "cursor" && key !== "limit" && value !== "") {
        nextSearchParams.set(key, value);
      }
    }
    if (limit !== AUDIT_DEFAULT_PAGE_SIZE) {
      nextSearchParams.set("limit", String(limit));
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">审计日志</h1>
        <p className="mt-2 text-sm text-slate-600">
          管理操作的 append-only 审计痕迹（只读）。campusId 为空的行按「无校区归属记录」呈现——
          历史行混有全局操作与未记录归属的旧数据，不进行任何推断。
        </p>
      </div>

      <form
        aria-label="审计筛选"
        method="get"
        action="/governance/audit"
        className="mb-6 grid gap-3 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:grid-cols-2 lg:grid-cols-3"
      >
        <label className="text-xs font-medium text-slate-600">
          操作（action）
          <input
            name="action"
            defaultValue={parsedFilters.data?.action ?? ""}
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
            placeholder="如 SUSPEND_USER"
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          目标类型（targetType）
          <input
            name="targetType"
            defaultValue={parsedFilters.data?.targetType ?? ""}
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
            placeholder="如 USER / APPEAL"
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          操作者 ID（actorId）
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
          起始日期（UTC）
          <input
            name="from"
            type="date"
            defaultValue={parsedFilters.data?.from ?? ""}
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          结束日期（UTC）
          <input
            name="to"
            type="date"
            defaultValue={parsedFilters.data?.to ?? ""}
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
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
          <Link href="/governance/audit" className="ml-1 text-slate-900 underline">
            审计日志首页
          </Link>
          重新进入。
        </div>
      ) : page.items.length === 0 ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          当前筛选条件下没有审计记录。
        </div>
      ) : (
        <div className="grid gap-4">
          {page.items.map((item) => (
            <article
              key={item.id}
              className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white">
                  {item.action}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {item.targetType}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {item.scope === "CAMPUS"
                    ? `校区：${item.campusName ?? "未知校区"}`
                    : "无校区归属记录"}
                </span>
                {item.result !== "SUCCESS" ? (
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
                    结果：{item.result}
                  </span>
                ) : null}
              </div>
              <div className="mt-3 space-y-1 text-sm text-slate-600">
                <p>操作者：{item.actor.displayName}</p>
                <p>
                  目标：{item.targetType} / {item.targetId}
                </p>
                <p>时间：{formatDateTime(item.createdAt)}</p>
              </div>
              {item.metadata.length > 0 ? (
                <dl className="mt-3 flex flex-wrap gap-2">
                  {item.metadata.map((entry) => (
                    <div
                      key={entry.key}
                      className="rounded-xl bg-slate-50 px-3 py-1 text-xs text-slate-600"
                    >
                      <dt className="inline font-medium text-slate-700">{entry.label}：</dt>
                      <dd className="inline">{entry.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </article>
          ))}
        </div>
      )}

      {page.nextCursor ? (
        <div className="mt-6 flex justify-end">
          <Link
            href={`/governance/audit?${nextSearchParams.toString()}`}
            className="rounded-full border border-slate-200 bg-white px-5 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-950"
          >
            下一页
          </Link>
        </div>
      ) : null}
    </div>
  );
}
