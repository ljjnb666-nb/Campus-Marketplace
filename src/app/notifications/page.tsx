import Link from "next/link";
import { Bell, CheckCheck, Info, ShieldAlert, ShoppingBag, ArrowRight } from "lucide-react";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { markAllNotificationsRead, markNotificationRead } from "@/actions/notification";
import { requireUser } from "@/lib/server-auth";
import { getNotificationsForUser } from "@/repositories/notification-repository";

export const dynamic = "force-dynamic";

function formatNotificationTime(date: Date) {
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const TYPE_CONFIG: Record<string, { label: string; icon: typeof Bell; color: string }> = {
  SYSTEM: { label: "系统通知", icon: Info, color: "text-indigo-600 bg-indigo-50 dark:bg-indigo-950/50 dark:text-indigo-400" },
  ORDER: { label: "订单通知", icon: ShoppingBag, color: "text-blue-600 bg-blue-50 dark:bg-blue-950/50 dark:text-blue-400" },
  TRUST: { label: "安全与举报", icon: ShieldAlert, color: "text-amber-600 bg-amber-50 dark:bg-amber-950/50 dark:text-amber-400" },
  RENTAL: { label: "租赁通知", icon: ShoppingBag, color: "text-purple-600 bg-purple-50 dark:bg-purple-950/50 dark:text-purple-400" },
};

export default async function NotificationsPage() {
  const user = await requireUser();
  const notifications = await getNotificationsForUser(user.id);
  const unreadCount = notifications.filter((n) => !n.isRead).length;

  return (
    <PageContainer maxWidth="standard" className="py-6 sm:py-8 space-y-6">
      <PageHeader
        title="系统与通知中心"
        description="接收校园集市官方提醒、订单交易变动及安全处置通知"
        action={
          unreadCount > 0 ? (
            <form action={markAllNotificationsRead}>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-2xl bg-indigo-50 px-4 py-2.5 text-xs font-bold text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950/50 dark:text-indigo-300 dark:hover:bg-indigo-900"
              >
                <CheckCheck className="size-4" />
                <span>全部标为已读 ({unreadCount})</span>
              </button>
            </form>
          ) : undefined
        }
      />

      {notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-3xl border border-slate-200/80 bg-white p-12 text-center space-y-3 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="size-14 flex items-center justify-center rounded-3xl bg-slate-100 text-slate-400 dark:bg-slate-800">
            <Bell className="size-7" />
          </div>
          <h3 className="font-bold text-slate-900 dark:text-slate-100 text-base">暂无任何通知</h3>
          <p className="text-xs text-slate-500">有新的订单交易或审核通知时将在此提醒。</p>
        </div>
      ) : (
        <div className="space-y-3">
          {notifications.map((n) => {
            const config = TYPE_CONFIG[n.type] || {
              label: "系统提醒",
              icon: Bell,
              color: "text-slate-600 bg-slate-100",
            };
            const Icon = config.icon;

            return (
              <div
                key={n.id}
                className={`group flex items-start gap-4 rounded-3xl border p-5 transition shadow-xs ${
                  n.isRead
                    ? "border-slate-200/70 bg-white dark:border-slate-800 dark:bg-slate-900 opacity-80"
                    : "border-indigo-100 bg-white dark:border-indigo-900/40 dark:bg-slate-900 ring-1 ring-indigo-500/10"
                }`}
              >
                <div className={`size-10 shrink-0 flex items-center justify-center rounded-2xl ${config.color}`}>
                  <Icon className="size-5" />
                </div>

                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-slate-900 text-sm dark:text-slate-100">
                        {n.title}
                      </span>
                      <StatusBadge label={config.label} variant={n.isRead ? "neutral" : "primary"} />
                    </div>
                    <span className="text-xs text-slate-400 shrink-0">
                      {formatNotificationTime(n.createdAt)}
                    </span>
                  </div>

                  <p className="text-xs text-slate-600 leading-relaxed dark:text-slate-300 whitespace-pre-wrap">
                    {n.content}
                  </p>

                  <div className="flex items-center justify-between pt-2">
                    {n.orderId ? (
                      <Link
                        href={`/my/orders`}
                        className="inline-flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
                      >
                        <span>查看相关订单</span>
                        <ArrowRight className="size-3.5" />
                      </Link>
                    ) : (
                      <span />
                    )}

                    {!n.isRead && (
                      <form action={markNotificationRead}>
                        <input type="hidden" name="notificationId" value={n.id} />
                        <button
                          type="submit"
                          className="text-[11px] font-semibold text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                        >
                          标记已读
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}
