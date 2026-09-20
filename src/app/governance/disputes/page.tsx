import Link from "next/link";

import { DISPUTE_STATUS_LABELS } from "@/constants/dispute";
import { requireDisputeReviewer } from "@/lib/disputes/dispute-access";
import {
  decodeDisputeCursor,
  listDisputeQueueCampuses,
  loadAuthorizedDisputeQueue,
  DISPUTE_QUEUE_DEFAULT_PAGE_SIZE,
  type DisputeCursor,
  type DisputeQueueFilters,
} from "@/lib/disputes/dispute-query";
import { disputeQueueFilterSchema, disputeQueueLimitSchema } from "@/validators/governance-dispute";

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
 * Phase 7G 纠纷运营队列（授权在 DB 查询内；exact-pair，directive 冻结）。
 * - 队列行仅 triage 最小面：无 reason / evidence / adminNote / email 等
 *   （queue privacy DTO 合同）；
 * - 排序 = dueAt ASC, createdAt ASC, id ASC（SLA 优先；canonical keyset cursor）；
 * - 所有 filter 恒 AND 在授权谓词之内（不能通过 filter 扩大授权范围）；
 * - overdue = active ∧ dueAt < now（只读计算，零自动执法——auto RESOLVED/
 *   auto CLOSED/auto restriction/auto suspension 均为冻结禁区）。
 */
export default async function GovernanceDisputesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, access } = await requireDisputeReviewer();

  const params = await searchParams;

  // invalid limit → 安全回退默认值（cursor 才是位置语义，不能静默纠正）
  let limit = DISPUTE_QUEUE_DEFAULT_PAGE_SIZE;
  const rawLimit = readParam(params, "limit");
  if (rawLimit !== undefined) {
    const parsedLimit = disputeQueueLimitSchema.safeParse(rawLimit);
    if (parsedLimit.success) {
      limit = parsedLimit.data;
    }
  }

  // 空串/畸形 cursor = present → 解码失败 → 安全失败态
  let cursor: DisputeCursor | null = null;
  let cursorInvalid = false;
  const rawCursor = readParam(params, "cursor");
  if (rawCursor !== undefined) {
    const decoded = decodeDisputeCursor(rawCursor);
    if (!decoded) {
      cursorInvalid = true;
    } else {
      cursor = decoded;
    }
  }

  const filtersResult = disputeQueueFilterSchema
    .pick({ campus: true, status: true, assignment: true, overdue: true })
    .safeParse({
      campus: readParam(params, "campus"),
      status: readParam(params, "status"),
      assignment: readParam(params, "assignment"),
      overdue: readParam(params, "overdue"),
    });

  // 非法 filter 值 = 未提供（filter 是收敛语义，静默忽略不改变授权范围）
  const filters: DisputeQueueFilters = filtersResult.success
    ? {
        campusId: filtersResult.data.campus,
        status: filtersResult.data.status,
        assignment: filtersResult.data.assignment,
        overdueOnly: filtersResult.data.overdue !== undefined,
      }
    : {};

  const page = cursorInvalid
    ? { items: [], nextCursor: null }
    : await loadAuthorizedDisputeQueue({
        viewerId: user.id,
        access,
        cursor: cursor ?? undefined,
        limit,
        filters,
      });

  // campus 过滤下拉：GLOBAL → 全部校区；campus reviewer → 仅其有效 scope 校区
  const campusOptions = await listDisputeQueueCampuses(access);

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
    return qs ? `/governance/disputes?${qs}` : "/governance/disputes";
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">纠纷处理</h1>
        <p className="mt-2 text-sm text-slate-600">
          按办理时限排序的租赁纠纷运营队列。纠纷处理结果不构成责任认定，处罚须走执法流程。
        </p>
      </div>

      <form
        aria-label="队列过滤"
        method="get"
        action="/governance/disputes"
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
            {Object.entries(DISPUTE_STATUS_LABELS).map(([value, label]) => (
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
          <Link href="/governance/disputes" className="ml-1 text-slate-900 underline">
            纠纷处理首页
          </Link>
          重新进入。
        </div>
      ) : page.items.length === 0 ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          当前没有符合条件的纠纷。
        </div>
      ) : (
        <div className="grid gap-4">
          {page.items.map((item) => (
            <article
              key={item.disputeId}
              className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {DISPUTE_STATUS_LABELS[item.status]}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  校区：{item.campusName}
                </span>
                {item.overdue ? (
                  <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">
                    已超时
                  </span>
                ) : null}
                {item.assignedReviewer ? (
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    领用人：{item.assignedReviewer}
                  </span>
                ) : null}
              </div>
              <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_220px]">
                <div className="space-y-2 text-sm text-slate-600">
                  <p>订单：{item.safeOrderLabel}</p>
                  <p>发起人：{item.initiatorName}</p>
                  <p>创建时间：{formatDateTime(item.createdAt)}</p>
                  <p>办理时限：{formatDateTime(item.dueAt)}</p>
                </div>
                <div className="space-y-3">
                  <Link
                    href={`/governance/disputes/${item.disputeId}`}
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
