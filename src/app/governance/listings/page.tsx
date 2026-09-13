import Link from "next/link";
import { notFound } from "next/navigation";

import {
  moderateErrandListingAction,
  moderateProductListingAction,
  moderateRentalListingAction,
  moderateServiceListingAction,
  type ListingModerationActionState,
} from "@/actions/governance-listings";
import { ListingTakedownForm } from "@/components/governance/listing-moderation-forms";
import {
  LISTING_MODERATION_QUEUE_SUBTITLE,
  LISTING_MODERATION_QUEUE_TITLE,
  LISTING_MODERATION_REASON_LABELS,
  LISTING_MODERATION_TARGET_LABELS,
} from "@/constants/governance-listings";
import {
  browseListings,
  loadActiveModerations,
  loadReportFlaggedListings,
  LISTING_MODERATION_TARGET_TYPES,
  type ModerationQueueItem,
} from "@/lib/moderation/listing-moderation-query";
import {
  deriveListingModerationAccess,
  hasAnyListingModerationAccess,
  type ListingModerationAccess,
} from "@/lib/moderation/listing-moderation-access";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";
import {
  decodeListingModerationCursor,
  listingModerationPageLimitSchema,
  listingModerationTypeFilterSchema,
  LISTING_MODERATION_DEFAULT_PAGE_SIZE,
  LISTING_MODERATION_MAX_PAGE_SIZE,
  type ListingModerationCursor,
} from "@/validators/governance-listing";

export const dynamic = "force-dynamic";

const TAKEDOWN_ACTIONS = {
  PRODUCT: moderateProductListingAction,
  SERVICE: moderateServiceListingAction,
  ERRAND: moderateErrandListingAction,
  RENTAL: moderateRentalListingAction,
} satisfies Record<
  (typeof LISTING_MODERATION_TARGET_TYPES)[number],
  (formData: FormData) => Promise<ListingModerationActionState>
>;

const QUEUE_TABS = [
  { key: "reports", label: "待处置举报" },
  { key: "active", label: "治理处置中" },
  { key: "browse", label: "浏览检视" },
] as const;

function formatDateTime(value: Date | string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function buildTabHref(tab: string, type: string | undefined, cursor?: string) {
  const params = new URLSearchParams({ tab });
  if (type) {
    params.set("type", type);
  }
  if (cursor) {
    params.set("cursor", cursor);
  }
  return `/governance/listings?${params.toString()}`;
}

function ModerationQueueRow({ item }: { item: ModerationQueueItem }) {
  const takedownAction = TAKEDOWN_ACTIONS[item.targetType];
  return (
    <article
      key={item.key}
      className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
      data-testid="moderation-queue-item"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
          {LISTING_MODERATION_TARGET_LABELS[item.targetType] ?? "未知类型"}
        </span>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
          状态：{item.businessStatus}
        </span>
        {item.activeModeration ? (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
            治理处置中
          </span>
        ) : null}
        {item.openReportReasons.length > 0 ? (
          <span className="rounded-full bg-rose-100 px-3 py-1 text-xs font-medium text-rose-700">
            未结举报 {item.openReportReasons.length} 条
          </span>
        ) : null}
      </div>
      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_260px]">
        <div className="space-y-2 text-sm text-slate-600">
          <p className="text-base font-semibold text-slate-950">{item.title}</p>
          <p>校区：{item.campusName ?? "未知"}</p>
          <p>发布者：{item.ownerDisplayName ?? "未知"}</p>
          <p>创建时间：{formatDateTime(item.createdAt)}</p>
          {item.activeModeration ? (
            <p>处置时间：{formatDateTime(item.activeModeration.createdAt)}</p>
          ) : null}
          {item.openReportReasons.length > 0 ? (
            <p>
              举报原因（只读）：
              {item.openReportReasons
                .map((reason) => LISTING_MODERATION_REASON_LABELS[reason] ?? "未知")
                .join("、")}
            </p>
          ) : null}
          <Link
            href={`/governance/listings/${item.targetType.toLowerCase()}/${item.listingId}`}
            className="inline-block text-sm font-medium text-indigo-600 underline"
          >
            打开治理详情
          </Link>
        </div>
        {item.activeModeration ? null : (
          <div className="space-y-3">
            <ListingTakedownForm action={takedownAction} listingId={item.listingId} />
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * Phase 7C 治理队列（/governance/listings，R6/R1 冻结）：
 * - 页面自守 listing moderation access（layout union 之外第二层纵深）；
 * - tab① 待处置举报（Report 域只读 badge，RENTAL 举报链不足由 tab③ 兜底）；
 * - tab② 治理处置中（活跃 ListingModeration 行）；
 * - tab③ 浏览检视（独立于举报域：type/title 检索 + campus 自动 scope）；
 * - GLOBAL → 无 campus 过滤；campus-scoped → campusId IN manageable；
 * - DTO 最小面（R2 §23）：无 email/phone/price/description/report 自由文本。
 */
export default async function GovernanceListingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; type?: string; cursor?: string; limit?: string; q?: string }>;
}) {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access: ListingModerationAccess = deriveListingModerationAccess(context);
  if (!hasAnyListingModerationAccess(access)) {
    notFound();
  }

  const params = await searchParams;
  const tab = QUEUE_TABS.some((candidate) => candidate.key === params.tab)
    ? (params.tab as (typeof QUEUE_TABS)[number]["key"])
    : "reports";

  const parsedType = params.type !== undefined
    ? listingModerationTypeFilterSchema.safeParse(params.type)
    : undefined;
  const typeFilter = parsedType?.success ? parsedType.data : undefined;

  let limit = LISTING_MODERATION_DEFAULT_PAGE_SIZE;
  if (params.limit !== undefined) {
    const parsedLimit = listingModerationPageLimitSchema.safeParse(params.limit);
    if (parsedLimit.success) {
      limit = Math.min(parsedLimit.data, LISTING_MODERATION_MAX_PAGE_SIZE);
    }
  }

  let cursor: ListingModerationCursor | undefined;
  let cursorInvalid = false;
  if (params.cursor !== undefined) {
    const decoded = decodeListingModerationCursor(params.cursor);
    if (!decoded) {
      cursorInvalid = true;
    } else {
      cursor = decoded;
    }
  }

  let items: ModerationQueueItem[] = [];
  let nextCursor: string | null = null;
  if (!cursorInvalid) {
    if (tab === "active") {
      items = await loadActiveModerations({ access, cursor: cursor ?? null, limit });
    } else {
      const types = typeFilter ? [typeFilter] : [...LISTING_MODERATION_TARGET_TYPES];
      const pages = await Promise.all(
        types.map((targetType) =>
          tab === "browse"
            ? browseListings({ access, targetType, cursor: cursor ?? null, limit })
            : loadReportFlaggedListings({ access, targetType, cursor: cursor ?? null, limit }),
        ),
      );
      // 多类型合并：按 createdAt 倒序后截取 limit（keyset 语义以首页为主）
      items = pages
        .flat()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
      if (items.length === limit) {
        const last = items[items.length - 1];
        nextCursor = Buffer.from(
          JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.listingId }),
        ).toString("base64url");
      }
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">{LISTING_MODERATION_QUEUE_TITLE}</h1>
        <p className="mt-2 text-sm text-slate-600">{LISTING_MODERATION_QUEUE_SUBTITLE}</p>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        {QUEUE_TABS.map((candidate) => (
          <Link
            key={candidate.key}
            href={buildTabHref(candidate.key, params.type)}
            className={`rounded-full px-4 py-2 text-sm font-medium transition ${
              tab === candidate.key
                ? "bg-slate-950 text-white"
                : "border border-slate-200 bg-white text-slate-700 hover:border-slate-300"
            }`}
          >
            {candidate.label}
          </Link>
        ))}
        {tab !== "active" ? (
          <form className="ml-auto flex items-center gap-2" method="get">
            <input type="hidden" name="tab" value={tab} />
            <select
              name="type"
              defaultValue={params.type ?? ""}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
            >
              <option value="">全部类型</option>
              {LISTING_MODERATION_TARGET_TYPES.map((targetType) => (
                <option key={targetType} value={targetType}>
                  {LISTING_MODERATION_TARGET_LABELS[targetType]}
                </option>
              ))}
            </select>
            {tab === "browse" ? (
              <input
                name="q"
                defaultValue={params.q ?? ""}
                placeholder="标题检索"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
              />
            ) : null}
            <button
              type="submit"
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700"
            >
              筛选
            </button>
          </form>
        ) : null}
      </div>

      {cursorInvalid ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          分页链接无效，请返回
          <Link href="/governance/listings" className="ml-1 text-slate-900 underline">
            内容治理首页
          </Link>
          重新进入。
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          当前视图没有待处理内容。
        </div>
      ) : (
        <div className="grid gap-4">
          {items.map((item) => (
            <ModerationQueueRow key={item.key} item={item} />
          ))}
        </div>
      )}

      {nextCursor ? (
        <div className="mt-6 flex justify-end">
          <Link
            href={buildTabHref(tab, params.type, nextCursor)}
            className="rounded-full border border-slate-200 bg-white px-5 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-950"
          >
            下一页
          </Link>
        </div>
      ) : null}
    </div>
  );
}
