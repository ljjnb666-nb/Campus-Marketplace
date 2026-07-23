import { toggleUserStatus } from "@/actions/admin";
import { USER_ROLE_LABELS, VERIFICATION_STATUS_LABELS } from "@/constants/user";
import { requireAdmin } from "@/lib/server-auth";
import { getAdminUserList } from "@/repositories/admin-repository";

export const dynamic = "force-dynamic";

function formatDate(value: Date | null) {
  if (!value) {
    return "暂无记录";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export default async function AdminUsersPage() {
  await requireAdmin();
  const users = await getAdminUserList();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">用户管理</h1>
        <p className="mt-2 text-sm text-slate-600">查看用户状态、认证情况和基础活跃度指标。</p>
      </div>

      <div className="grid gap-4">
        {users.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            当前还没有可管理的用户数据。
          </div>
        ) : (
          users.map((user) => (
            <article key={user.id} className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
                <div className="space-y-3 text-sm text-slate-600">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-950">{user.name}</h2>
                    <p className="mt-1">{user.email}</p>
                  </div>
                  <div className="flex flex-wrap gap-3 text-xs text-slate-500">
                    <span>{user.schoolName}</span>
                    <span>·</span>
                    <span>{user.campus.name}</span>
                    <span>·</span>
                    <span>{USER_ROLE_LABELS[user.role]}</span>
                  </div>
                  <div className="flex flex-wrap gap-4 text-sm">
                    <span>账号状态：{user.status === "ACTIVE" ? "正常" : "已停用"}</span>
                    <span>认证状态：{VERIFICATION_STATUS_LABELS[user.verificationStatus]}</span>
                    <span>信用分：{user.creditScore}</span>
                    <span>完成订单：{user.completedOrdersCount}</span>
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs text-slate-500">
                    <span>商品 {user._count.products}</span>
                    <span>任务 {user._count.createdErrandTasks}</span>
                    <span>服务 {user._count.serviceListings}</span>
                    <span>订单 {user._count.buyerOrders}</span>
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs text-slate-500">
                    <span>注册时间：{formatDate(user.createdAt)}</span>
                    <span>最近登录：{formatDate(user.lastLoginAt)}</span>
                  </div>
                </div>

                <form action={toggleUserStatus} className="flex items-center">
                  <input type="hidden" name="userId" value={user.id} />
                  <input
                    type="hidden"
                    name="nextStatus"
                    value={user.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE"}
                  />
                  <button
                    type="submit"
                    className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                  >
                    {user.status === "ACTIVE" ? "停用账号" : "恢复账号"}
                  </button>
                </form>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
