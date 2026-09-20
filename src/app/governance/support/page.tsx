import Link from "next/link";

import { SUPPORT_TICKET_CATEGORY_LABELS, SUPPORT_TICKET_STATUS_LABELS } from "@/constants/support";
import { requireSupportAgent } from "@/lib/support/support-access";
import {
  decodeSupportCursor,
  listSupportQueueCampuses,
  loadAuthorizedSupportQueue,
  SUPPORT_QUEUE_DEFAULT_PAGE_SIZE,
  type SupportCursor,
  type SupportQueueFilters,
} from "@/lib/support/support-query";
import { supportQueueFilterSchema, supportQueueLimitSchema } from "@/validators/governance-support";

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

/** 7D 教训：GET 空串参数 = 未提供（防 hydration 双挂载严格校验假阳性）。 */
function readParam(params: Record<string, string | string[] | undefined>, key: string) {
  const value = params[key];
  const normalized = Array.isArray(value) ? value[0] : value;
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/**
 * Phase 7G 支持工单运营队列（授权在 DB 查询内；UNSCOPED 仅 GLOBAL）。
 * - 队列行仅 triage 最小面：无 description / internalNote / email / phone
 *   （queue privacy DTO 合同；subject 为 triage 标题，允许）；
 * - 排序 = dueAt ASC, createdAt ASC, id ASC；canonical keyset cursor（25/50）；
 * - overdue = active ∧ dueAt < now（只读；auto resolve/close/escalate 冻结禁区）。
 */
export default async function GovernanceSupportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, access } = await requireSupportAgent();

  const params = await searchParams;

  let limit = SUPPORT_QUEUE_DEFAULT_PAGE_SIZE;
  const rawLimit = readParam(params, "limit");
  if (rawLimit !== undefined) {
    const parsedLimit = supportQueueLimitSchema.safeParse(rawLimit);
    if (parsedLimit.success) {
      limit = parsedLimit.data;
    }
  }

  let cursor: SupportCursor | null = null;
  let cursorInvalid = false;
  const rawCursor = readParam(params, "cursor");
  if (rawCursor !== undefined) {
    const decoded = decodeSupportCursor(rawCursor);
    if (!decoded) {
      cursorInvalid = true;
    } else {
      cursor = decoded;
    }
  }

  const filtersResult = supportQueueFilterSchema
    .pick({ campus: true, status: true, assignment: true, overdue: true })
    .safeParse({
      campus: readParam(params, "campus"),
      status: readParam(params, "status"),
      assignment: readParam(params, "assignment"),
      overdue: readParam(params, "overdue"),
    });

  const filters: SupportQueueFilters = filtersResult.success
    ? {
        campusId: filtersResult.data.campus,
        status: filtersResult.data.status,
        assignment: filtersResult.data.assignment,
        overdueOnly: filtersResult.data.overdue !== undefined,
      }
    : {};

  const page = cursorInvalid
    ? { items: [], nextCursor: null }
    : await loadAuthorizedSupportQueue({
        viewerId: user.id,
        access,
        cursor: cursor ?? undefined,
        limit,
        filters,
      });

  const campusOptions = await listSupportQueueCampuses(access);

  function buildPageHref(overrides: Record<string, string | undefined>) {
    const merged: Record<string, string | undefined> = {
      campus: filters.campusId,
      status: filters.status,
      assignment: filters.assignment,
      overdue: filters.overdueOnly ? "1" : undefined,
      limit: String(limit),
      ...overrides,
    };
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) {
      if (value) {
        search.set(key, value);
      }
    }
    const qs = search.toString();
    return qs ? `/governance/support?${qs}` : "/governance/support";
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">支持工单</h1>
        <p className="mt-2 text-sm text-slate-600">
          按办理时限排序的支持工单队列。无校区归属的工单仅平台级专员可见。
        </p>
      </div>

      <form
        aria-label="队列过滤"
        method="get"
        action="/governance/support"
        className="mb-6 flex flex-wrap items-end gap-3 rounded-[24px] border border-slate-200 bg-white p-4"
      >
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          校区
          <select
            name="campus"
            defaultValue={filters.campusId ?? ""}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400"
          >
            <option value="">全部可见范围</option>
            {campusOptions.map((campus) => (
              <option key={campus.id} value={campus.id}>
                {campus.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          状态
          <select
            name="status"
            defaultValue={filters.status ?? ""}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400"
          >
            <option value="">全部</option>
            {Object.entries(SUPPORT_TICKET_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          领用
          <select
            name="assignment"
            defaultValue={filters.assignment ?? "all"}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400"
          >
            <option value="all">全部</option>
            <option value="mine">我领用的</option>
            <option value="unassigned">未领用</option>
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-xs font-medium text-slate-600">
          <input
            type="checkbox"
            name="overdue"
            value="1"
            defaultChecked={filters.overdueOnly}
            className="size-4 rounded border-slate-300"
          />
          仅看已超时
        </label>
        <button
          type="submit"
          className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
        >
          应用过滤
        </button>
      </form>

      {cursorInvalid ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          分页链接无效，请返回
          <Link href="/governance/support" className="ml-1 text-slate-900 underline">
            支持工单首页
          </Link>
          重新进入。
        </div>
      ) : page.items.length === 0 ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          当前没有符合条件的工单。
        </div>
      ) : (
        <div className="grid gap-4">
          {page.items.map((item) => (
            <article
              key={item.ticketId}
              className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {SUPPORT_TICKET_STATUS_LABELS[item.status]}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {item.category in SUPPORT_TICKET_CATEGORY_LABELS
                    ? SUPPORT_TICKET_CATEGORY_LABELS[item.category as keyof typeof SUPPORT_TICKET_CATEGORY_LABELS]
                    : item.category}
                </span>
                {item.campusName ? (
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    校区：{item.campusName}
                  </span>
                ) : (
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    无校区归属
                  </span>
                )}
                {item.overdue ? (
                  <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">
                    已超时
                  </span>
                ) : null}
                {item.assignedAgent ? (
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    领用人：{item.assignedAgent}
                  </span>
                ) : null}
              </div>
              <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_220px]">
                <div className="space-y-2 text-sm text-slate-600">
                  <p>主题：{item.subject}</p>
                  <p>提交人：{item.requesterName}</p>
                  <p>创建时间：{formatDateTime(item.createdAt)}</p>
                  <p>办理时限：{formatDateTime(item.dueAt)}</p>
                </div>
                <div className="space-y-3">
                  <Link
                    href={`/governance/support/${item.ticketId}`}
                    className="block rounded-full border border-slate-200 px-4 py-2 text-center text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                  >
                    查看详情
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {page.nextCursor ? (
        <div className="mt-6 flex justify-end">
          <Link
            href={buildPageHref({ cursor: page.nextCursor })}
            className="rounded-full border border-slate-200 bg-white px-5 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-950"
          >
            下一页
          </Link>
        </div>
      ) : null}
    </div>
  );
}
