import Link from "next/link";

import { VERIFICATION_STATUS_LABELS } from "@/constants/user";
import { requireVerificationReviewer } from "@/lib/campus/verification-review-access";
import {
  decodeVerificationCursor,
  listVerificationQueueCampuses,
  loadAuthorizedVerificationQueue,
  VERIFICATION_QUEUE_DEFAULT_PAGE_SIZE,
  type VerificationCursor,
  type VerificationQueueFilters,
} from "@/lib/campus/verification-review-query";
import { verificationQueueFilterSchema, verificationQueueLimitSchema } from "@/validators/governance-verification";

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
 * Phase 7F 认证审核队列（授权在 DB 查询内；scope truth =
 * UserVerification.membership.campusId ∧ membership ACTIVE）：
 * - 队列行仅 triage 最小面：无 email / studentIdLast4 / studentCardImage /
 *   asset id / reviewNote / raw policy metadata（DTO 最小化合同）；
 * - 排序 = reviewDueAt ASC, submittedAt ASC, id ASC（SLA 优先；keyset 全
 *   tuple cursor）；
 * - 默认 status = PENDING；所有 filter 恒 AND 在授权谓词之内；
 * - overdue = PENDING ∧ reviewDueAt < now（只读计算，零自动决定/零执法）。
 */
export default async function GovernanceVerificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { access } = await requireVerificationReviewer();

  const params = await searchParams;

  // invalid limit → 安全回退默认值（cursor 才是位置语义，不能静默纠正）
  let limit = VERIFICATION_QUEUE_DEFAULT_PAGE_SIZE;
  const rawLimit = readParam(params, "limit");
  if (rawLimit !== undefined) {
    const parsedLimit = verificationQueueLimitSchema.safeParse(rawLimit);
    if (parsedLimit.success) {
      limit = parsedLimit.data;
    }
  }

  // 空串/畸形 cursor = present → 解码失败 → 安全失败态
  let cursor: VerificationCursor | null = null;
  let cursorInvalid = false;
  const rawCursor = readParam(params, "cursor");
  if (rawCursor !== undefined) {
    const decoded = decodeVerificationCursor(rawCursor);
    if (!decoded) {
      cursorInvalid = true;
    } else {
      cursor = decoded;
    }
  }

  const filtersResult = verificationQueueFilterSchema
    .pick({ campus: true, status: true, overdue: true })
    .safeParse({
      campus: readParam(params, "campus"),
      status: readParam(params, "status"),
      overdue: readParam(params, "overdue"),
    });

  // 非法 filter 值 = 未提供；status 未提供时默认 PENDING（运营队列语义）
  const filters: VerificationQueueFilters = filtersResult.success
    ? {
        campusId: filtersResult.data.campus,
        status: filtersResult.data.status ?? "PENDING",
        overdueOnly: filtersResult.data.overdue !== undefined,
      }
    : { status: "PENDING" };

  const page = cursorInvalid
    ? { items: [], nextCursor: null }
    : await loadAuthorizedVerificationQueue({
        access,
        cursor: cursor ?? undefined,
        limit,
        filters,
      });

  // campus 过滤下拉：GLOBAL → 全部 active 校区；campus reviewer → 仅其有效
  // scope 校区。选项集合由授权派生，绝不提供越权选项。
  const campusOptions = await listVerificationQueueCampuses(access);

  function buildPageHref(overrides: Record<string, string | undefined>) {
    const merged: Record<string, string | undefined> = {
      campus: filters.campusId,
      status: filters.status,
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
    return qs ? `/governance/verifications?${qs}` : "/governance/verifications";
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">认证审核</h1>
        <p className="mt-2 text-sm text-slate-600">
          按审核时限排序的校园认证队列。超时仅影响排序与提示，不会自动产生任何认证决定。
        </p>
      </div>

      <form
        aria-label="队列过滤"
        method="get"
        action="/governance/verifications"
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
            defaultValue={filters.status ?? "PENDING"}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400"
          >
            <option value="PENDING">审核中</option>
            {Object.entries(VERIFICATION_STATUS_LABELS)
              .filter(([value]) => value !== "UNVERIFIED")
              .map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
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
          <Link href="/governance/verifications" className="ml-1 text-slate-900 underline">
            认证审核首页
          </Link>
          重新进入。
        </div>
      ) : page.items.length === 0 ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          当前没有符合条件的认证申请。
        </div>
      ) : (
        <div className="grid gap-4">
          {page.items.map((item) => (
            <article
              key={item.verificationId}
              className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {VERIFICATION_STATUS_LABELS[item.status]}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {item.campusName}
                </span>
                {item.overdue ? (
                  <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">
                    审核已超时
                  </span>
                ) : null}
              </div>
              <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_160px]">
                <div className="space-y-2 text-sm text-slate-600">
                  <p className="text-base font-semibold text-slate-950">{item.userDisplayName}</p>
                  <p>提交时间：{formatDateTime(item.submittedAt)}</p>
                  <p>审核时限：{formatDateTime(item.reviewDueAt)}</p>
                </div>
                <div className="space-y-3">
                  <Link
                    href={`/governance/verifications/${item.verificationId}`}
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
