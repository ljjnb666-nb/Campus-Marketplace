import Link from "next/link";
import { notFound } from "next/navigation";

import { reviewGovernanceVerification } from "@/actions/governance-verifications";
import { VerificationReviewForm } from "@/components/governance/verification-review-forms";
import { PrivateAssetViewer } from "@/components/shared/private-asset-viewer";
import { VERIFICATION_STATUS_LABELS } from "@/constants/user";
import { requireVerificationReviewer } from "@/lib/campus/verification-review-access";
import { loadAuthorizedVerificationDetail } from "@/lib/campus/verification-review-query";

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
 * Phase 7F 认证详情（两阶段读；每请求独立重授权，绝不信任队列可见性）：
 * - Stage A 最小锚点 → 授权（missing / inactive membership / 越权 统一
 *   notFound，无存在性 oracle——D02/D03/D04/D06）；
 * - Stage B 敏感水合：学号后四位 / 证据引用 / reviewNote / policy 快照仅
 *   在授权通过后进入；证据实际读取仍必须经 /api/assets/:assetId/access +
 *   content 独立鉴权（含 sensitive access audit）；
 * - 审核操作 = canonical decideMembershipVerification 薄入口；PENDING→
 *   VERIFIED/REJECTED、VERIFIED→REVOKED 的合法性由状态机锁内断言。
 */
export default async function GovernanceVerificationDetailPage({
  params,
}: {
  params: Promise<{ verificationId: string }>;
}) {
  const { access } = await requireVerificationReviewer();
  const { verificationId } = await params;

  const result = await loadAuthorizedVerificationDetail({
    access,
    verificationId,
  });

  if (!result.ok) {
    notFound();
  }

  const { detail } = result;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <Link href="/governance/verifications" className="text-sm text-slate-600 hover:text-slate-950">
        ← 返回认证审核
      </Link>

      <div className="mt-6 mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold text-slate-950">认证详情</h1>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            {VERIFICATION_STATUS_LABELS[detail.status]}
          </span>
          {detail.overdue ? (
            <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">
              审核已超时
            </span>
          ) : null}
        </div>
      </div>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold text-slate-950">申请信息</h2>
        <dl className="grid gap-2 text-sm text-slate-600">
          <div>申请人：{detail.userDisplayName}</div>
          <div>学校：{detail.schoolName}</div>
          <div>申请校区（自填）：{detail.campusName}</div>
          <div>学号后四位：{detail.studentIdLast4}</div>
          {detail.policyVersion !== null ? (
            <div>认证策略版本：v{detail.policyVersion}</div>
          ) : null}
          <div>提交时间：{formatDateTime(detail.submittedAt)}</div>
          <div>审核时限：{formatDateTime(detail.reviewDueAt)}</div>
          {detail.reviewedAt ? <div>上次审核时间：{formatDateTime(detail.reviewedAt)}</div> : null}
          {detail.reviewedByName ? <div>上次审核人：{detail.reviewedByName}</div> : null}
        </dl>
        {detail.studentCardImageRef ? (
          <div className="mt-4 text-sm text-slate-600">
            <PrivateAssetViewer value={detail.studentCardImageRef} label="查看学生证材料" />
          </div>
        ) : detail.evidenceUnavailable ? (
          // RB-01：历史证据值（legacy 直链/外链/未知串/失效引用）fail closed，
          // 仅显示非泄露状态，绝不输出原始 URL / 对象路径
          <div className="mt-4 text-sm text-slate-500" data-evidence-unavailable="true">
            历史认证材料不可用（仅支持平台加密材料）
          </div>
        ) : null}
      </section>

      {detail.reviewNote || detail.reasonCode ? (
        <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-xl font-semibold text-slate-950">上次审核记录</h2>
          <dl className="grid gap-2 text-sm text-slate-600">
            {detail.reasonCode ? <div>原因码：{detail.reasonCode}</div> : null}
            <div>审核备注：{detail.reviewNote ?? "无"}</div>
          </dl>
        </section>
      ) : null}

      <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-2 text-xl font-semibold text-slate-950">审核操作</h2>
        <p className="mb-4 text-sm text-slate-600">
          {detail.status === "PENDING"
            ? "当前申请待审核：可通过、可驳回。"
            : detail.status === "VERIFIED"
              ? "该用户已认证：可吊销认证（需其重新提交后才能恢复）。"
              : "该申请已有终局结论；用户重新提交后会以新申请进入队列。"}
        </p>
        <VerificationReviewForm
          action={reviewGovernanceVerification}
          verificationId={detail.verificationId}
          status={detail.status}
        />
      </section>
    </div>
  );
}
