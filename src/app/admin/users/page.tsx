import { redirect } from "next/navigation";

/**
 * Phase 7F legacy retirement：/admin/users 已退役——canonical 用户运营面是
 * /governance/users（GLOBAL user.suspend ONLY；账号状态 mutation 唯一
 * authority = suspendAccount/reinstateAccount canonical enforcement seam）。
 *
 * redirect 无条件执行（无 requireAdmin 桥）：未授权访问会在目标页被
 * requireUserOperationsAdmin → notFound 拦截，本页不再暴露 legacy admin
 * 存在性。旧 toggleUserStatus action 保留为同 seam 的薄 adapter（零第二
 * mutation authority）。
 */
export default function AdminUsersPage() {
  redirect("/governance/users");
}
