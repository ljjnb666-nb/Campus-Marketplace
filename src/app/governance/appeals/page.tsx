import Link from "next/link";

import {
  beginGovernanceAppealReview,
} from "@/actions/governance-appeals";
import { BeginReviewForm } from "@/components/governance/appeal-review-forms";
import {
  APPEAL_STATUS_LABELS,
  ENFORCEMENT_TYPE_LABELS,
} from "@/constants/governance";
import { loadAuthorizedAppealQueue } from "@/lib/appeals/review-queue";
import { requireAppealReviewer } from "@/lib/appeals/reviewer-access";
import { APPEAL_DEFAULT_PAGE_SIZE, APPEAL_MAX_PAGE_SIZE, appealPageLimitSchema, decodeAppealCursor, type AppealCursor } from "@/validators/appeal";

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
 * Phase 7A 申诉审核队列（授权在 DB 查询内，Planning §14-§18 冻结）。
 * - 队列行仅 triage 最小面：无 statement/decisionNote/EA.note/email 等；
 * - selfReview 徽标：viewer 为原执行者时的非阻断预警（§25）；
 * - keyset 分页：invalid cursor → 安全失败态（不泄露数据、不回退首页）。
 * - 队列行内直接提供「开始审核」：IN_REVIEW 无 ownership 语义，任何授权
 *   审核员可从队列或详情推进（begin 失败由 action 回传统一错误反馈）。
 */
export default async function GovernanceAppealsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; limit?: string }>;
}) {
  const { user, access } = await requireAppealReviewer();

  const params = await searchParams;

  // invalid limit → 安全回退默认值（cursor 才是位置语义，不能静默纠正）
  let limit = APPEAL_DEFAULT_PAGE_SIZE;
  if (params.limit !== undefined) {
    const parsedLimit = appealPageLimitSchema.safeParse(params.limit);
    if (parsedLimit.success) {
      limit = Math.min(parsedLimit.data, APPEAL_MAX_PAGE_SIZE);
    }
  }

  // Repair 1 §7：空串/畸形 cursor = present → 解码失败 → 安全失败态
  let cursor: AppealCursor | undefined;
  let cursorInvalid = false;
  if (params.cursor !== undefined) {
    const decoded = decodeAppealCursor(params.cursor);
    if (!decoded) {
      cursorInvalid = true;
    } else {
      cursor = decoded;
    }
  }

  const page = cursorInvalid
    ? { items: [], nextCursor: null }
    : await loadAuthorizedAppealQueue({
        viewerId: user.id,
        access,
        cursor,
        limit,
      });

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">申诉审核</h1>
        <p className="mt-2 text-sm text-slate-600">
          处理用户对执法处罚提交的申诉。开始审核不占用/锁定申诉，任一有权审核员均可作出决定。
        </p>
      </div>

      {cursorInvalid ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          分页链接无效，请返回
          <Link href="/governance/appeals" className="ml-1 text-slate-900 underline">
            申诉审核首页
          </Link>
          重新进入。
        </div>
      ) : page.items.length === 0 ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          当前没有待处理的申诉。
        </div>
      ) : (
        <div className="grid gap-4">
          {page.items.map((item) => (
            <article
              key={item.id}
              className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {APPEAL_STATUS_LABELS[item.status]}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {ENFORCEMENT_TYPE_LABELS[item.enforcementType]}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {item.scopeKind === "GLOBAL"
                    ? "全平台"
                    : `校区：${item.campusName ?? "未知校区"}`}
                </span>
                {item.selfReview ? (
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
                    你是该处罚的原执行者
                  </span>
                ) : null}
              </div>
              <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_220px]">
                <div className="space-y-2 text-sm text-slate-600">
                  <p>申诉人：{item.appellantName}</p>
                  <p>提交时间：{formatDateTime(item.createdAt)}</p>
                </div>
                <div className="space-y-3">
                  <Link
                    href={`/governance/appeals/${item.id}`}
                    className="block rounded-full border border-slate-200 px-4 py-2 text-center text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                  >
                    查看详情
                  </Link>
                  {item.status === "SUBMITTED" ? (
                    <BeginReviewForm
                      action={beginGovernanceAppealReview}
                      appealId={item.id}
                    />
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {page.nextCursor ? (
        <div className="mt-6 flex justify-end">
          <Link
            href={`/governance/appeals?cursor=${encodeURIComponent(page.nextCursor)}&limit=${limit}`}
            className="rounded-full border border-slate-200 bg-white px-5 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-950"
          >
            下一页
          </Link>
        </div>
      ) : null}
    </div>
  );
}
