import Link from "next/link";
import { updateProfile } from "@/actions/user";
import { ProfileForm } from "@/components/profile/profile-form";
import { VERIFICATION_STATUS_LABELS } from "@/constants/user";
import { requireUser } from "@/lib/server-auth";
import { getProfileDashboard } from "@/repositories/user-repository";

export const dynamic = "force-dynamic";

function formatDate(value: Date | null) {
  if (!value) {
    return "暂无记录";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(value);
}

export default async function ProfilePage() {
  const currentUser = await requireUser();
  const { user, unreadNotifications, unreadConversations } = await getProfileDashboard(
    currentUser.id,
  );

  const statCards = [
    { label: "我的商品", value: user._count.products, href: "/my/products" },
    { label: "我的任务", value: user._count.createdErrandTasks, href: "/my/errands" },
    { label: "我的服务", value: user._count.serviceListings, href: "/my/services" },
    {
      label: "我的订单",
      value: user._count.buyerOrders + user._count.sellerOrders,
      href: "/my/orders",
    },
    { label: "未读通知", value: unreadNotifications, href: "/notifications" },
    { label: "未读会话", value: unreadConversations, href: "/messages" },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-6">
          <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-slate-500">{user.schoolName}</p>
                <h1 className="mt-2 text-3xl font-semibold text-slate-950">{user.name}</h1>
                <p className="mt-2 text-sm text-slate-600">
                  {user.bio ?? "还没有填写个人简介。"}
                </p>
              </div>
              <div className="rounded-full border border-slate-200 px-4 py-2 text-sm text-slate-700">
                {VERIFICATION_STATUS_LABELS[user.verificationStatus]}
              </div>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
                <p className="text-slate-500">学院 / 年级</p>
                <p className="mt-2 font-medium text-slate-950">
                  {user.college ?? "未填写"} / {user.grade ?? "未填写"}
                </p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
                <p className="text-slate-500">手机号</p>
                <p className="mt-2 font-medium text-slate-950">{user.phone ?? "未填写"}</p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
                <p className="text-slate-500">完成订单</p>
                <p className="mt-2 font-medium text-slate-950">{user.completedOrdersCount}</p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
                <p className="text-slate-500">收件箱概况</p>
                <p className="mt-2 font-medium text-slate-950">
                  {unreadNotifications} 条通知 / {unreadConversations} 个未读会话
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-2 text-sm text-slate-600">
              <p>信用分：{user.creditScore}</p>
              <p>好评率：{Math.round(user.positiveReviewRate * 100)}%</p>
              <p>最近登录：{formatDate(user.lastLoginAt)}</p>
            </div>
          </section>

          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {statCards.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300"
              >
                <p className="text-sm text-slate-500">{item.label}</p>
                <p className="mt-3 text-3xl font-semibold text-slate-950">{item.value}</p>
              </Link>
            ))}
            <Link
              href="/my/privacy"
              className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300"
            >
              <p className="text-sm text-slate-500">隐私与数据</p>
              <p className="mt-3 text-sm font-medium text-sky-700">
                协议同意记录 · 导出数据 · 注销账号
              </p>
            </Link>
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-slate-950">校园认证</h2>
                <p className="mt-2 text-sm text-slate-600">
                  当前状态：{VERIFICATION_STATUS_LABELS[user.verificationStatus]}
                </p>
              </div>
              <Link
                href="/verification"
                className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
              >
                前往认证页
              </Link>
            </div>
            {user.verification?.reviewNote ? (
              <p className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
                审核备注：{user.verification.reviewNote}
              </p>
            ) : null}
          </section>
        </div>

        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-6">
            <h2 className="text-2xl font-semibold text-slate-950">编辑个人资料</h2>
            <p className="mt-2 text-sm text-slate-600">
              完善你的公开资料，提升交易和接单时的信任感。
            </p>
          </div>
          <ProfileForm
            action={updateProfile}
            initialValues={{
              name: user.name,
              bio: user.bio,
              college: user.college,
              grade: user.grade,
              phone: user.phone,
              avatarUrl: user.avatarUrl,
            }}
          />
        </section>
      </div>
    </div>
  );
}
