import Link from "next/link";
import { notFound } from "next/navigation";

import {
  createVerificationPolicyDraftAction,
  deactivateGovernanceCampusAction,
  activateGovernanceCampusAction,
  publishVerificationPolicyAction,
  retireVerificationPolicyAction,
  updateGovernanceCampusMetadataAction,
  updateVerificationPolicyDraftAction,
} from "@/actions/governance-campus";
import {
  CampusToggleForm,
  CreatePolicyDraftForm,
  DraftPolicyForm,
  PublishedPolicyActions,
  UpdateCampusMetadataForm,
} from "@/components/governance/campus-admin-forms";
import { requireCampusManager } from "@/lib/campus/campus-admin-access";
import {
  getGovernanceCampusDetail,
  getGovernanceCampusExists,
} from "@/lib/campus/campus-governance-query";

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

const POLICY_STATUS_LABELS: Record<string, string> = {
  DRAFT: "草稿",
  PUBLISHED: "已发布",
  RETIRED: "已退役",
};

/**
 * Phase 7H：校区管理详情（两阶段读，§20 冻结纪律）：
 *   Stage A — getGovernanceCampusExists（仅 id 存在锚点；不存在 → notFound，
 *   与未授权同形，无存在性 oracle）
 *   → requireCampusManager（GLOBAL campus.manage）
 *   → Stage B — campus metadata / membership summary / policy versions。
 *
 * GLOBAL-only 也不养成 sensitive preload：本页绝不读取成员身份、认证证据、
 * 私有备注。策略 instructions 仅对 DRAFT 行读取并仅呈现在编辑表单（§29）。
 */
export default async function GovernanceCampusDetailPage({
  params,
}: {
  params: Promise<{ campusId: string }>;
}) {
  const { campusId } = await params;

  // ---- Stage A：最小存在性锚点 ----
  const exists = await getGovernanceCampusExists(campusId);
  if (!exists) {
    notFound();
  }

  // ---- authorization ----
  await requireCampusManager();

  // ---- Stage B ----
  const detail = await getGovernanceCampusDetail(campusId);
  if (!detail) {
    // Stage A ↔ B 竞态：与 notFound 同形
    notFound();
  }

  const { campus } = detail;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold text-slate-950">{campus.name}</h1>
          <span
            className={
              campus.isActive
                ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700"
                : "rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700"
            }
          >
            {campus.isActive ? "启用中" : "已停用"}
          </span>
        </div>
        <p className="mt-2 text-sm text-slate-600">
          标识符（slug，创建后不可修改）：<span data-testid="campus-slug">{campus.slug}</span>
        </p>
        <Link href="/governance/campuses" className="mt-2 inline-block text-sm text-slate-500 underline">
          返回校区列表
        </Link>
      </div>

      <section
        aria-label="校区概况"
        className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2 className="mb-3 text-xl font-semibold text-slate-950">校区概况</h2>
        <div className="grid gap-2 text-sm text-slate-600 md:grid-cols-2">
          <p>学校：{campus.schoolName}</p>
          <p>所在区域：{campus.district ?? "—"}</p>
          <p>有效成员：{detail.activeMembershipCount}</p>
          <p>待审认证：{detail.pendingVerificationCount}</p>
          <p>创建时间：{formatDateTime(campus.createdAt)}</p>
          <p>更新时间：{formatDateTime(campus.updatedAt)}</p>
        </div>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section
          aria-label="编辑校区信息"
          className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
        >
          <h2 className="mb-4 text-xl font-semibold text-slate-950">编辑校区信息</h2>
          <UpdateCampusMetadataForm
            action={updateGovernanceCampusMetadataAction}
            campusId={campus.id}
            name={campus.name}
            schoolName={campus.schoolName}
            district={campus.district}
          />
        </section>

        <section
          aria-label="启用或停用校区"
          className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
        >
          <h2 className="mb-2 text-xl font-semibold text-slate-950">启用 / 停用</h2>
          <p className="mb-4 text-sm text-slate-600">
            停用仅表示校区暂停开放（不再出现在注册与准入入口），不影响既有成员身份、在架内容、在途订单、纠纷与工单。
          </p>
          <CampusToggleForm
            action={campus.isActive ? deactivateGovernanceCampusAction : activateGovernanceCampusAction}
            campusId={campus.id}
            nextIsActive={!campus.isActive}
          />
        </section>
      </div>

      <section aria-label="认证策略版本" className="mt-10">
        <h2 className="mb-4 text-xl font-semibold text-slate-950">认证策略版本</h2>

        <div className="mb-6 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-base font-semibold text-slate-950">创建新草稿</h3>
          <CreatePolicyDraftForm action={createVerificationPolicyDraftAction} campusId={campus.id} />
        </div>

        {detail.policyVersions.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            该校区还没有认证策略版本。
          </div>
        ) : (
          <div className="grid gap-4">
            {detail.policyVersions.map((policy) => (
              <article
                key={policy.id}
                className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-base font-semibold text-slate-950">
                    v{policy.version} · {policy.title}
                  </h3>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    {POLICY_STATUS_LABELS[policy.status] ?? policy.status}
                  </span>
                  {policy.status === "PUBLISHED" ? (
                    <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700">
                      当前版本候选
                    </span>
                  ) : null}
                </div>
                <div className="mt-3 grid gap-2 text-xs text-slate-500 md:grid-cols-2">
                  <p>生效时间：{formatDateTime(policy.effectiveAt)}</p>
                  <p>发布时间：{policy.publishedAt ? formatDateTime(policy.publishedAt) : "—"}</p>
                  <p className="md:col-span-2">内容指纹：{policy.contentHash}</p>
                </div>
                {policy.status === "DRAFT" && policy.draftInstructions !== undefined ? (
                  <DraftPolicyForm
                    updateAction={updateVerificationPolicyDraftAction}
                    publishAction={publishVerificationPolicyAction}
                    retireAction={retireVerificationPolicyAction}
                    campusId={campus.id}
                    policy={{
                      id: policy.id,
                      version: policy.version,
                      title: policy.title,
                      draftInstructions: policy.draftInstructions,
                      effectiveAt: policy.effectiveAt,
                    }}
                  />
                ) : (
                  <PublishedPolicyActions
                    retireAction={retireVerificationPolicyAction}
                    campusId={campus.id}
                    policyId={policy.id}
                  />
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
