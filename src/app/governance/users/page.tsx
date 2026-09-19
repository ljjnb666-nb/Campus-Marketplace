import Link from "next/link";

import { VERIFICATION_STATUS_LABELS } from "@/constants/user";
import {
  decodeUserCursor,
  listUserQueueCampuses,
  loadUserOperationsQueue,
  USER_QUEUE_DEFAULT_PAGE_SIZE,
  type UserCursor,
  type UserQueueFilters,
} from "@/lib/governance/user-operations-query";
import { requireUserOperationsAdmin } from "@/lib/governance/user-operations-access";
import { userQueueFilterSchema, userQueueLimitSchema } from "@/validators/governance-user";

export const dynamic = "force-dynamic";

const USER_STATUS_LABELS = {
  ACTIVE: "正常",
  SUSPENDED: "已停用",
} as const;

function formatDateTime(value: string | null) {
  if (!value) {
    return "暂无记录";
  }
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
 * Phase 7F 用户运营队列（授权 = GLOBAL user.suspend ONLY，入口 resolver 已挡）：
 * - DTO 最小化：无 email / studentId / 私有认证证据 / role authority /
 *   creditScore / internal notes（UP01-UP05）；
 * - 排序 = createdAt DESC, id DESC（keyset 全 tuple cursor）；
 * - 所有 filter 恒 AND（只能缩小结果，不能扩大授权范围）；
 * - deleted / erased 用户结构性排除（存在性反 oracle）。
 */
export default async function GovernanceUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUserOperationsAdmin();

  const params = await searchParams;

  // invalid limit → 安全回退默认值（cursor 才是位置语义，不能静默纠正）
  let limit = USER_QUEUE_DEFAULT_PAGE_SIZE;
  const rawLimit = readParam(params, "limit");
  if (rawLimit !== undefined) {
    const parsedLimit = userQueueLimitSchema.safeParse(rawLimit);
    if (parsedLimit.success) {
      limit = parsedLimit.data;
    }
  }

  // 空串/畸形 cursor = present → 解码失败 → 安全失败态
  let cursor: UserCursor | null = null;
  let cursorInvalid = false;
  const rawCursor = readParam(params, "cursor");
  if (rawCursor !== undefined) {
    const decoded = decodeUserCursor(rawCursor);
    if (!decoded) {
      cursorInvalid = true;
    } else {
      cursor = decoded;
    }
  }

  const filtersResult = userQueueFilterSchema
    .pick({ status: true, verification: true, campus: true })
    .safeParse({
      status: readParam(params, "status"),
      verification: readParam(params, "verification"),
      campus: readParam(params, "campus"),
    });

  // 非法 filter 值 = 未提供（filter 是收敛语义，静默忽略不改变结果范围）
  const filters: UserQueueFilters = filtersResult.success
    ? {
        status: filtersResult.data.status,
        verificationStatus: filtersResult.data.verification,
        campusId: filtersResult.data.campus,
      }
    : {};

  const page = cursorInvalid
    ? { items: [], nextCursor: null }
    : await loadUserOperationsQueue({ cursor: cursor ?? undefined, limit, filters });

  // campus 过滤下拉（GLOBAL-only 面：全部 active 校区；仅展示便利）
  const campusOptions = await listUserQueueCampuses();

  function buildPageHref(overrides: Record<string, string | undefined>) {
    const merged: Record<string, string | undefined> = {
      status: filters.status,
      verification: filters.verificationStatus,
      campus: filters.campusId,
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
    return qs ? `/governance/users?${qs}` : "/governance/users";
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">用户管理</h1>
        <p className="mt-2 text-sm text-slate-600">
          平台账号运营队列（停用/恢复走 canonical 账号执法，记录可在执法读面追溯）。
        </p>
      </div>

      <form
        aria-label="队列过滤"
        method="get"
        action="/governance/users"
        className="mb-6 flex flex-wrap items-end gap-3 rounded-[24px] border border-slate-200 bg-white p-4"
      >
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          账号状态
          <select
            name="status"
            defaultValue={filters.status ?? ""}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400"
          >
            <option value="">全部</option>
            {Object.entries(USER_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          认证状态
          <select
            name="verification"
            defaultValue={filters.verificationStatus ?? ""}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400"
          >
            <option value="">全部</option>
            {Object.entries(VERIFICATION_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          校区
          <select
            name="campus"
            defaultValue={filters.campusId ?? ""}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400"
          >
            <option value="">全部校区</option>
            {campusOptions.map((campus) => (
              <option key={campus.id} value={campus.id}>
                {campus.name}
              </option>
            ))}
          </select>
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
          <Link href="/governance/users" className="ml-1 text-slate-900 underline">
            用户管理首页
          </Link>
          重新进入。
        </div>
      ) : page.items.length === 0 ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          当前没有符合条件的用户。
        </div>
      ) : (
        <div className="grid gap-4">
          {page.items.map((item) => (
            <article
              key={item.userId}
              className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    item.status === "ACTIVE"
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-red-100 text-red-700"
                  }`}
                >
                  {USER_STATUS_LABELS[item.status]}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {VERIFICATION_STATUS_LABELS[item.effectiveVerificationStatus]}
                </span>
                {item.activeCampusNames.length > 0 ? (
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    {item.activeCampusNames.join(" · ")}
                  </span>
                ) : null}
              </div>
              <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_160px]">
                <div className="space-y-2 text-sm text-slate-600">
                  <p className="text-base font-semibold text-slate-950">{item.displayName}</p>
                  <p>注册时间：{formatDateTime(item.createdAt)}</p>
                  <p>最近登录：{formatDateTime(item.lastLoginAt)}</p>
                </div>
                <div className="space-y-3">
                  <Link
                    href={`/governance/users/${item.userId}`}
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
