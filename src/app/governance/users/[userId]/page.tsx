import Link from "next/link";
import { notFound } from "next/navigation";

import {
  reinstateGovernanceUser,
  suspendGovernanceUser,
} from "@/actions/governance-users";
import { ReinstateUserForm, SuspendUserForm } from "@/components/governance/user-action-forms";
import { VERIFICATION_STATUS_LABELS } from "@/constants/user";
import { requireUserOperationsAdmin } from "@/lib/governance/user-operations-access";
import { loadUserOperationsDetail } from "@/lib/governance/user-operations-query";

export const dynamic = "force-dynamic";

const USER_STATUS_LABELS = {
  ACTIVE: "正常",
  SUSPENDED: "已停用",
} as const;

const MEMBERSHIP_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效",
  PENDING: "待确认",
  REJECTED: "未通过",
  SUSPENDED: "已暂停",
  LEFT: "已离开",
};

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
 * Phase 7F 用户详情（两阶段读；每请求独立重授权）：
 * - Stage A 最小锚点（不读 email/studentId/认证材料/私有备注）→
 *   missing/deleted/erased 统一 notFound（无存在性 oracle，U05）；
 * - Stage B 安全水合：maskedEmail / memberships / canonical 有效认证投影
 *   （FR01：deriveEffectiveVerification SSOT，非 legacy 投影）；
 *   FR02：绝不读取/呈现 RiskState（user.suspend ≠ enforcement.read ≠
 *   audit.read 的能力分离）——canonical 风险/执法读面在
 *   /governance/enforcement/targets/[userId]（自守 enforcement.read），
 *   本页仅提供链接，不复制 EnforcementAction history；
 * - 停用/恢复 = canonical suspendAccount/reinstateAccount 薄入口
 *   （privileged target / self / 幂等由域锁内 fail closed，U06/U07）。
 */
export default async function GovernanceUserDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  await requireUserOperationsAdmin();
  const { userId } = await params;

  const result = await loadUserOperationsDetail({ userId });
  if (!result.ok) {
    notFound();
  }

  const { detail } = result;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <Link href="/governance/users" className="text-sm text-slate-600 hover:text-slate-950">
        ← 返回用户管理
      </Link>

      <div className="mt-6 mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold text-slate-950">{detail.displayName}</h1>
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              detail.status === "ACTIVE"
                ? "bg-emerald-100 text-emerald-700"
                : "bg-red-100 text-red-700"
            }`}
          >
            {USER_STATUS_LABELS[detail.status]}
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            {VERIFICATION_STATUS_LABELS[detail.effectiveVerificationStatus]}
          </span>
        </div>
      </div>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold text-slate-950">账号信息</h2>
        <dl className="grid gap-2 text-sm text-slate-600">
          <div>邮箱：{detail.maskedEmail}</div>
          <div>注册时间：{formatDateTime(detail.createdAt)}</div>
          <div>最近登录：{formatDateTime(detail.lastLoginAt)}</div>
        </dl>
      </section>

      <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold text-slate-950">校区成员身份</h2>
        {detail.memberships.length === 0 ? (
          <p className="text-sm text-slate-500">暂无校区成员身份记录。</p>
        ) : (
          <ul className="grid gap-2 text-sm text-slate-600">
            {detail.memberships.map((membership) => (
              <li key={`${membership.campusName}-${membership.status}`}>
                {membership.campusName} · {MEMBERSHIP_STATUS_LABELS[membership.status] ?? membership.status}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold text-slate-950">执法记录</h2>
        <p className="text-sm text-slate-600">
          风险状态与执法历史在执法读面呈现（独立授权，本页不重复读取）。
        </p>
        <div className="mt-4">
          <Link
            href={`/governance/enforcement/targets/${detail.userId}`}
            className="text-sm text-slate-600 underline hover:text-slate-950"
          >
            查看执法记录（canonical 读面）→
          </Link>
        </div>
      </section>

      <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-2 text-xl font-semibold text-slate-950">账号操作</h2>
        <p className="mb-4 text-sm text-slate-600">
          停用/恢复由平台账号执法服务执行：操作写入执法记录与管理审计，
          高权限账号与本人账号受保护。
        </p>
        {detail.status === "ACTIVE" ? (
          <SuspendUserForm action={suspendGovernanceUser} userId={detail.userId} />
        ) : (
          <ReinstateUserForm action={reinstateGovernanceUser} userId={detail.userId} />
        )}
      </section>
    </div>
  );
}
