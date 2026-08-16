import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { auth } from "@/lib/auth";
import { getUnreadConversationCount } from "@/repositories/conversation-repository";
import { getUnreadNotificationCount } from "@/repositories/notification-repository";
import { AppSessionProvider } from "@/components/providers/session-provider";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { MobileBottomNav } from "@/components/ui/mobile-bottom-nav";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXTAUTH_URL ?? "http://localhost:3000"),
  title: "校园集市 - 校内二手、跑腿、技能与租赁平台",
  description: "面向大学校园的同校二手交易、跑腿接单、技能服务与闲置租赁平台。",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await auth();
  // 未登录时跳过按用户维度的数据库查询，头部徽标按 0 渲染。
  const [unreadNotificationCount, unreadConversationCount] = session?.user?.id
    ? await Promise.all([
        getUnreadNotificationCount(session.user.id),
        getUnreadConversationCount(session.user.id),
      ])
    : [0, 0];

  return (
    <html
      lang="zh-CN"
      data-scroll-behavior="smooth"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-slate-50/50 text-slate-900 selection:bg-indigo-500 selection:text-white dark:bg-slate-950 dark:text-slate-100">
        <AppSessionProvider>
          <div className="flex min-h-screen flex-col pb-16 lg:pb-0">
            <SiteHeader
              unreadNotificationCount={unreadNotificationCount}
              unreadConversationCount={unreadConversationCount}
            />
            <main className="flex-1">{children}</main>
            <SiteFooter />
            <MobileBottomNav />
          </div>
        </AppSessionProvider>
      </body>
    </html>
  );
}
