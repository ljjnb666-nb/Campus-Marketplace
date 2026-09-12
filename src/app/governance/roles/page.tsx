import Link from "next/link";
import { notFound } from "next/navigation";

import {
  grantGovernanceRole,
  lookupRoleGrantCandidate,
  revokeGovernanceRole,
} from "@/actions/governance-roles";
import {
  CampusRoleGrantForm,
  RevokeRoleButton,
} from "@/components/governance/role-manage-forms";
import {
  GOVERNANCE_ROLE_LABELS,
  ROLE_MANAGE_PAGE_SUBTITLE,
  ROLE_MANAGE_PAGE_TITLE,
} from "@/constants/governance-roles";
import { loadManageableRoleCampuses, loadManagedRoleAssignments } from "@/lib/rbac/role-assignment-query";
import {
  deriveRoleManageAccess,
  hasAnyRoleManageAccess,
} from "@/lib/rbac/role-manage-access";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";
import {
  GOVERNANCE_ROLE_DEFAULT_PAGE_SIZE,
  GOVERNANCE_ROLE_MAX_PAGE_SIZE,
  decodeGovernanceRoleCursor,
  governanceRolePageLimitSchema,
  type GovernanceRoleCursor,
} from "@/validators/governance-role";

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
 * Phase 7B 治理角色供给面（/governance/roles）。
 * - 页面自守 roleManage access（layout union gate 之外的第二层纵深）；
 * - 列表/picker 每请求独立派生（force-dynamic，零缓存）；
 * - invalid limit → 安全回退默认值；invalid cursor → 安全失败态（不泄露
 *   数据、不回退首页）；
 * - DTO 最小面：无 email/userId/roleId/scopeKey；内部 key 绝不回显
 *   （GOVERNANCE_ROLE_LABELS 之外的 roleKey 一律呈现「未知角色」）。
 */
export default async function GovernanceRolesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; limit?: string }>;
}) {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access = deriveRoleManageAccess(context);
  if (!hasAnyRoleManageAccess(access)) {
    notFound();
  }

  const params = await searchParams;

  let limit = GOVERNANCE_ROLE_DEFAULT_PAGE_SIZE;
  if (params.limit !== undefined) {
    const parsedLimit = governanceRolePageLimitSchema.safeParse(params.limit);
    if (parsedLimit.success) {
      limit = Math.min(parsedLimit.data, GOVERNANCE_ROLE_MAX_PAGE_SIZE);
    }
  }

  let cursor: GovernanceRoleCursor | undefined;
  let cursorInvalid = false;
  if (params.cursor !== undefined) {
    const decoded = decodeGovernanceRoleCursor(params.cursor);
    if (!decoded) {
      cursorInvalid = true;
    } else {
      cursor = decoded;
    }
  }

  const page = cursorInvalid
    ? { items: [], nextCursor: null }
    : await loadManagedRoleAssignments({ access, cursor, limit });
  const campuses = await loadManageableRoleCampuses(access);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">{ROLE_MANAGE_PAGE_TITLE}</h1>
        <p className="mt-2 text-sm text-slate-600">{ROLE_MANAGE_PAGE_SUBTITLE}</p>
      </div>

      <section className="mb-10">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">授予角色</h2>
        <CampusRoleGrantForm
          campuses={campuses}
          grantAction={grantGovernanceRole}
          lookupAction={lookupRoleGrantCandidate}
        />
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold text-slate-900">已授予的角色</h2>
        {cursorInvalid ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            分页链接无效，请返回
            <Link href="/governance/roles" className="ml-1 text-slate-900 underline">
              角色管理首页
            </Link>
            重新进入。
          </div>
        ) : page.items.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            当前没有可管理的角色授予。
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
                    {GOVERNANCE_ROLE_LABELS[item.roleKey] ?? "未知角色"}
                  </span>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    校区：{item.campusName}
                  </span>
                </div>
                <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_220px]">
                  <div className="space-y-2 text-sm text-slate-600">
                    <p>用户：{item.userDisplayName}</p>
                    <p>授予时间：{formatDateTime(item.assignedAt)}</p>
                    <p>授予人：{item.assignedByDisplayName}</p>
                  </div>
                  <div className="space-y-3">
                    <RevokeRoleButton action={revokeGovernanceRole} assignmentId={item.id} />
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {page.nextCursor ? (
        <div className="mt-6 flex justify-end">
          <Link
            href={`/governance/roles?cursor=${encodeURIComponent(page.nextCursor)}&limit=${limit}`}
            className="rounded-full border border-slate-200 bg-white px-5 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-950"
          >
            下一页
          </Link>
        </div>
      ) : null}
    </div>
  );
}
