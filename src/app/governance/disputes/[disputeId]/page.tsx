import Link from "next/link";
import { notFound } from "next/navigation";

import {
  claimGovernanceDispute,
  closeGovernanceDispute,
  releaseGovernanceDispute,
  resolveGovernanceDispute,
} from "@/actions/governance-disputes";
import {
  ClaimDisputeForm,
  DisputeDecisionForms,
  ReleaseDisputeForm,
} from "@/components/governance/dispute-review-forms";
import { PrivateAssetViewer } from "@/components/shared/private-asset-viewer";
import {
  DISPUTE_RESOLUTION_ACTION_LABELS,
  DISPUTE_RESOLUTION_CODE_LABELS,
  DISPUTE_STATUS_LABELS,
} from "@/constants/dispute";
import { requireDisputeReviewer } from "@/lib/disputes/dispute-access";
import { loadAuthorizedDisputeDetail } from "@/lib/disputes/dispute-query";

export const dynamic = "force-dynamic";

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

/**
 * Phase 7G 纠纷详情（两阶段读；每请求独立重授权，绝不信任队列可见性）：
 * - Stage A 最小锚点 → 授权（missing / malformed scope / 越权 统一
 *   notFound，无存在性 oracle）；
 * - Stage B 敏感水合：reason / evidence 引用 / adminNote / 当事人安全身份
 *   仅在授权通过后进入；证据实际读取仍必须经 /api/assets/:assetId/access +
 *   content 独立鉴权（dispute.evidence.read 精确绑定 + DISPUTE_EVIDENCE_
 *   ACCESSED 审计）；
 * - 操作控件按状态呈现：未领用 → 领用；本人领用 → 释放；active →
 *   解决/关闭（终局合法性由 canonical 服务锁内断言）；terminal 只读。
 */
export default async function GovernanceDisputeDetailPage({
  params,
}: {
  params: Promise<{ disputeId: string }>;
}) {
  const { user, context, access } = await requireDisputeReviewer();
  const { disputeId } = await params;

  const result = await loadAuthorizedDisputeDetail({
    viewerId: user.id,
    context,
    access,
    disputeId,
  });

  if (!result.ok) {
    notFound();
  }

  const { detail } = result;
  const isActive = detail.status === "OPEN" || detail.status === "IN_REVIEW";

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <Link href="/governance/disputes" className="text-sm text-slate-600 hover:text-slate-950">
        ← 返回纠纷处理
      </Link>

      <div className="mt-6 mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold text-slate-950">纠纷详情</h1>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            {DISPUTE_STATUS_LABELS[detail.status]}
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            校区：{detail.campusName}
          </span>
          {detail.overdue ? (
            <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">
              已超时
            </span>
          ) : null}
        </div>
      </div>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold text-slate-950">纠纷信息</h2>
        <dl className="grid gap-2 text-sm text-slate-600">
          <div>订单：{detail.safeOrderLabel}</div>
          <div>出租者：{detail.ownerName}</div>
          <div>租客：{detail.renterName}</div>
          <div>发起人：{detail.initiatorName}</div>
          <div>创建时间：{formatDateTime(detail.createdAt)}</div>
          <div>办理时限：{formatDateTime(detail.dueAt)}</div>
          {detail.openedFromOrderStatus ? (
            <div>纠纷前订单状态：{detail.openedFromOrderStatus}</div>
          ) : (
            <div className="text-amber-700">纠纷前订单状态：不可靠（恢复动作不可用）</div>
          )}
        </dl>
        <div className="mt-4 text-sm text-slate-600">
          <p className="font-medium text-slate-900">纠纷描述</p>
          <p className="mt-2 whitespace-pre-wrap rounded-2xl bg-slate-50 p-4">{detail.reason}</p>
        </div>
        <div className="mt-4 text-sm text-slate-600">
          <p className="font-medium text-slate-900">证据材料</p>
          {detail.evidenceRefs.length === 0 ? (
            <p className="mt-2">无证据材料</p>
          ) : detail.canViewEvidence ? (
            <ul className="mt-2 space-y-2">
              {detail.evidenceRefs.map((ref) => (
                <li key={ref}>
                  <PrivateAssetViewer value={ref} label="查看证据" />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-slate-500">
              共 {detail.evidenceRefs.length} 项证据材料（需要纠纷证据读取权限）
            </p>
          )}
        </div>
        {detail.adminNote ? (
          <div className="mt-4 text-sm text-slate-600">
            <p className="font-medium text-slate-900">操作备注</p>
            <p className="mt-2 whitespace-pre-wrap rounded-2xl bg-slate-50 p-4">{detail.adminNote}</p>
          </div>
        ) : null}
      </section>

      {detail.resolution.resolvedAt ? (
        <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-xl font-semibold text-slate-950">处理结果</h2>
          <dl className="grid gap-2 text-sm text-slate-600">
            <div>状态：{DISPUTE_STATUS_LABELS[detail.status]}</div>
            {detail.resolution.code ? (
              <div>
                处理结果：
                {
                  DISPUTE_RESOLUTION_CODE_LABELS[
                    detail.resolution.code as keyof typeof DISPUTE_RESOLUTION_CODE_LABELS
                  ]
                }
              </div>
            ) : null}
            {detail.resolution.action ? (
              <div>
                订单收敛动作：
                {
                  DISPUTE_RESOLUTION_ACTION_LABELS[
                    detail.resolution.action as keyof typeof DISPUTE_RESOLUTION_ACTION_LABELS
                  ]
                }
              </div>
            ) : null}
            <div>处理时间：{formatDateTime(detail.resolution.resolvedAt)}</div>
            {detail.resolution.resolvedByName ? (
              <div>处理人：{detail.resolution.resolvedByName}</div>
            ) : null}
          </dl>
        </section>
      ) : null}

      {isActive && detail.scopeAuthorized ? (
        <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-2 text-xl font-semibold text-slate-950">处理操作</h2>
          <p className="mb-4 text-sm text-slate-600">
            {detail.assignedReviewer === null
              ? "当前纠纷未被领用：可领用后推进，或直接作出终局处理。"
              : detail.selfAssigned
                ? "你已领用该纠纷：可释放领用或作出终局处理。"
                : `该纠纷由 ${detail.assignedReviewer.displayName} 领用；任一有权审核员均可直接作出终局处理。`}
          </p>
          <div className="space-y-6">
            {detail.assignedReviewer === null ? (
              <ClaimDisputeForm action={claimGovernanceDispute} disputeId={detail.disputeId} />
            ) : null}
            {detail.selfAssigned ? (
              <ReleaseDisputeForm action={releaseGovernanceDispute} disputeId={detail.disputeId} />
            ) : null}
            <DisputeDecisionForms
              resolveAction={resolveGovernanceDispute}
              closeAction={closeGovernanceDispute}
              disputeId={detail.disputeId}
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}
