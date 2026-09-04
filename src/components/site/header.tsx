import Link from "next/link";
import { auth } from "@/lib/auth";
import { HeaderLiveStatus } from "@/components/site/header-live-status";
import { UserMenu } from "@/components/site/user-menu";

const publicNavItems = [
  { href: "/products", label: "二手商品" },
  { href: "/errands", label: "跑腿大厅" },
  { href: "/services", label: "技能服务" },
  { href: "/rentals", label: "租赁广场" },
  { href: "/legal/rules", label: "平台规则" },
];

const accountNavItems = [
  { href: "/my/products", label: "我的商品" },
  { href: "/my/errands", label: "我的任务" },
  { href: "/my/services", label: "我的服务" },
  { href: "/my/orders", label: "我的订单" },
  { href: "/my/reviews", label: "我的评价" },
  { href: "/my/rental-orders", label: "我的租用" },
  { href: "/my/owner-orders", label: "我的出租" },
  { href: "/my/rental-listings", label: "出租物品" },
  { href: "/reports", label: "举报中心" },
  { href: "/profile", label: "个人中心" },
  { href: "/my/favorites", label: "我的收藏" },
  { href: "/my/privacy", label: "隐私与数据" },
];

type SiteHeaderProps = {
  /** 未读通知数，由 layout（应用层）查询后通过 props 传入。 */
  unreadNotificationCount?: number;
  /** 未读会话数，由 layout（应用层）查询后通过 props 传入。 */
  unreadConversationCount?: number;
};

export async function SiteHeader({
  unreadNotificationCount = 0,
  unreadConversationCount = 0,
}: SiteHeaderProps) {
  const session = await auth();

  const adminNavItems =
    session?.user?.role === "ADMIN"
      ? [
          { href: "/admin", label: "后台总览" },
          { href: "/admin/verifications", label: "认证审核" },
          { href: "/admin/reports", label: "举报处理" },
          { href: "/admin/categories", label: "分类管理" },
          { href: "/admin/keywords", label: "关键词管理" },
        ]
      : [];

  return (
    <header className="sticky top-0 z-50 border-b border-slate-200/80 bg-white/80 backdrop-blur-xl dark:border-slate-800/80 dark:bg-slate-950/80">
      <div className="mx-auto w-full max-w-7xl px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between gap-4">
          {/* Logo & Left Navigation */}
          <div className="flex items-center gap-6 lg:gap-8">
            <Link href="/" className="flex items-center gap-2.5 transition hover:opacity-85">
              <div className="flex size-9.5 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 to-indigo-700 text-sm font-bold text-white shadow-lg shadow-indigo-500/20">
                集
              </div>
              <div className="leading-tight">
                <p className="text-sm font-bold text-slate-950 dark:text-white">校园集市</p>
                <p className="hidden md:block text-[10px] text-slate-500 dark:text-slate-400">
                  校内二手、跑腿和技能撮合
                </p>
              </div>
            </Link>

            {/* Desktop Navigation Links */}
            <nav className="hidden md:flex items-center gap-5 text-sm font-semibold text-slate-650 dark:text-slate-300">
              {publicNavItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="transition hover:text-indigo-600 dark:hover:text-indigo-400"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>

          {/* Right Area */}
          <div className="flex items-center gap-3 sm:gap-4">
            {/* Live Message / Notification badges */}
            {session?.user ? (
              <div className="flex items-center gap-2">
                <HeaderLiveStatus
                  initialMessageCount={unreadConversationCount}
                  initialNotificationCount={unreadNotificationCount}
                />
              </div>
            ) : null}

            {/* 发布主按钮 (桌面端) */}
            <Link
              href="/products/new"
              className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 py-2 text-xs font-bold text-white shadow-md shadow-indigo-600/20 transition hover:from-indigo-700 hover:to-indigo-800 hover:shadow-lg active:scale-95"
            >
              <span>+ 发布闲置</span>
            </Link>

            {session?.user ? (
              <UserMenu
                user={{
                  id: session.user.id,
                  name: session.user.name,
                  email: session.user.email,
                  image: session.user.image,
                  role: session.user.role,
                }}
                accountNavItems={accountNavItems}
                adminNavItems={adminNavItems}
              />
            ) : (
              <div className="flex items-center gap-2">
                <Link
                  href="/login"
                  className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-xs transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
                >
                  登录
                </Link>
                <Link
                  href="/register"
                  className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-md transition hover:bg-slate-800 active:scale-[0.98] dark:bg-indigo-600 dark:hover:bg-indigo-700"
                >
                  注册
                </Link>
              </div>
            )}
          </div>
        </div>

        {/* Mobile Navigation Sub-bar */}
        <nav className="mt-2.5 flex md:hidden items-center gap-5 overflow-x-auto pb-1 text-xs font-semibold text-slate-600 dark:text-slate-400 scrollbar-hide border-t border-slate-100 pt-2 dark:border-slate-900">
          {publicNavItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="shrink-0 transition hover:text-indigo-600 dark:hover:text-indigo-400"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
