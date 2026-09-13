import Link from "next/link";
import { notFound } from "next/navigation";

import {
  moderateProductListingAction,
  moderateServiceListingAction,
  moderateErrandListingAction,
  moderateRentalListingAction,
  restoreListingModerationAction,
} from "@/actions/governance-listings";
import {
  loadListingModerationHistory,
  loadGovernanceListingDetail,
  type ModerationHistoryEntry,
} from "@/lib/moderation/listing-moderation-query";
import { ListingRestoreForm, ListingTakedownForm } from "@/components/governance/listing-moderation-forms";
import {
  LISTING_MODERATION_REASON_LABELS,
  LISTING_MODERATION_TARGET_LABELS,
} from "@/constants/governance-listings";
import {
  canModerateCampus,
  deriveListingModerationAccess,
} from "@/lib/moderation/listing-moderation-access";
import { loadAuthorizationContext, type AuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";
import type { ListingModerationTargetType } from "@prisma/client";

export const dynamic = "force-dynamic";

function formatDateTime(value: Date | string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/**
 * Phase 7C 治理详情（R2-02 冻结）：governance-only 现势内容检视面。
 * 每次请求：requireUser → loadAuthorizationContext → deriveAccess → parse
 * type → load listing → campusId 服务器解析 → exact campus 授权 →
 * self-moderation deny（owner=viewer）→ render。invalid type / missing /
 * unauthorized / cross-campus / owner 访问 → 统一 notFound()（防 oracle）。
 * DTO 允许现势内容（title/description/images/pricing/locationText 同公开
 * 暴露级）+ 治理历史；禁止 owner email/phone/studentId/认证材料/risk/
 * 私信/report 自由文本。restore 仅从本面执行（AWP token 由本面提供）。
 */
export default async function GovernanceListingDetailPage({
  params,
}: {
  params: Promise<{ type: string; id: string }>;
}) {
  const { type, id } = await params;
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  if (!context) {
    notFound();
  }
  const access = deriveListingModerationAccess(context as AuthorizationContext);
  if (!access.global && access.campusIds.length === 0) {
    notFound();
  }

  const normalizedType = type.toUpperCase();
  const targetType = (
    ["PRODUCT", "SERVICE", "ERRAND", "RENTAL"] as const
  ).find((candidate) => candidate === normalizedType);
  if (!targetType) {
    notFound();
  }

  const listing = await loadGovernanceListingDetail(targetType, id);
  if (!listing) {
    notFound();
  }

  // exact campus 授权（campusId 服务器侧从 listing 解析，绝不信任 URL/表单）
  if (!canModerateCampus(access, listing.campusId)) {
    notFound();
  }

  // self-moderation deny：owner 尝试进入治理视图 → notFound
  if (user.id === listing.ownerId) {
    notFound();
  }

  const history = await loadListingModerationHistory({ targetType, listingId: listing.listingId });
  const activeModeration = history.find((entry) => entry.resolvedAt === null) ?? null;

  const takedownAction =
    targetType === "PRODUCT"
      ? moderateProductListingAction
      : targetType === "SERVICE"
        ? moderateServiceListingAction
        : targetType === "ERRAND"
          ? moderateErrandListingAction
          : moderateRentalListingAction;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
              {LISTING_MODERATION_TARGET_LABELS[targetType]}
            </span>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
              业务状态：{listing.businessStatus}
            </span>
            {activeModeration ? (
              <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
                治理处置中
              </span>
            ) : null}
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-slate-950">{listing.title}</h1>
        </div>
        <Link
          href="/governance/listings"
          className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700"
        >
          返回治理队列
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <section className="space-y-4">
          <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-slate-500">发布者：{listing.ownerDisplayName}</p>
            <p className="text-sm text-slate-500">校区：{listing.campusName}</p>
            <p className="text-sm text-slate-500">
              创建：{formatDateTime(listing.createdAt)} · 最后更新：{formatDateTime(listing.updatedAt)}
            </p>
            {listing.pricing ? <p className="text-sm text-slate-500">价格：{listing.pricing}</p> : null}
            {listing.locationText ? <p className="text-sm text-slate-500">位置：{listing.locationText}</p> : null}
            <p className="mt-4 whitespace-pre-wrap text-sm text-slate-700">{listing.description || "（无描述）"}</p>
            {listing.imageUrls.length > 0 ? (
              <div className="mt-4 flex flex-wrap gap-3">
                {listing.imageUrls.map((url) => (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    key={url}
                    src={url}
                    alt={listing.title}
                    className="h-32 w-32 rounded-2xl border border-slate-200 object-cover"
                  />
                ))}
              </div>
            ) : null}
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-3 text-lg font-semibold text-slate-900">治理历史</h2>
            {history.length === 0 ? (
              <p className="text-sm text-slate-500">该内容暂无治理记录。</p>
            ) : (
              <ul className="space-y-3 text-sm text-slate-600">
                {history.map((entry: ModerationHistoryEntry) => (
                  <li key={entry.id} className="rounded-2xl border border-slate-100 p-3">
                    <p>
                      {LISTING_MODERATION_REASON_LABELS[entry.reasonCode] ?? "未知原因"}
                      · {entry.resolvedAt ? `已恢复（${formatDateTime(entry.resolvedAt)}，操作人 ${entry.resolvedByDisplayName ?? "未知"}）` : "处置中"}
                    </p>
                    <p className="text-xs text-slate-400">
                      处置人 {entry.moderatorDisplayName ?? "未知"} · {formatDateTime(entry.createdAt)}
                    </p>
                    {entry.note ? <p className="mt-1 text-xs text-slate-500">备注：{entry.note}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <aside className="space-y-4">
          {activeModeration ? (
            <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="mb-3 text-lg font-semibold text-slate-900">恢复公开展示</h2>
              <ListingRestoreForm
                action={restoreListingModerationAction}
                moderationId={activeModeration.id}
                listingUpdatedAt={listing.updatedAt.toISOString()}
              />
            </div>
          ) : (
            <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="mb-3 text-lg font-semibold text-slate-900">执行治理处置</h2>
              <ListingTakedownForm action={takedownAction} listingId={listing.listingId} />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
