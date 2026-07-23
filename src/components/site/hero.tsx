"use client";

import Link from "next/link";
import {
  Search,
  MapPin,
  Sparkles,
  Plus,
  BookOpen,
  Laptop,
  Truck,
  Printer,
  Code,
  Camera,
  ArrowUpRight,
  ShieldCheck,
  ShoppingBag as ProductIcon,
  Zap as ErrandIcon,
  Sparkles as ServiceIcon
} from "lucide-react";

const highlights = [
  "同校真实场景，沟通和交易链路更短",
  "支持线下当面交付，降低陌生交易风险",
  "二手、跑腿、技能服务统一入口管理",
  "数据直观清晰，分类目管理省时省力",
];

const shortcutLinks = [
  { href: "/search?q=教材", label: "教材资料", description: "找书、讲义和备考资料", icon: BookOpen, color: "from-blue-500 to-cyan-500" },
  { href: "/search?q=数码", label: "数码产品", description: "耳机、平板、配件快速筛选", icon: Laptop, color: "from-indigo-500 to-purple-500" },
  { href: "/search?q=快递", label: "代取快递", description: "优先查看即时跑腿需求", icon: Truck, color: "from-amber-500 to-orange-500" },
  { href: "/search?q=打印", label: "代打印", description: "当天完成的校内任务", icon: Printer, color: "from-teal-500 to-emerald-500" },
  { href: "/search?q=编程", label: "编程辅导", description: "辅导、答疑与项目支持", icon: Code, color: "from-pink-500 to-rose-500" },
  { href: "/search?q=摄影", label: "摄影剪辑", description: "活动拍摄与内容制作", icon: Camera, color: "from-violet-500 to-fuchsia-500" },
] as const;

export function HeroSection({
  summary,
}: {
  summary: {
    productCount: number;
    errandCount: number;
    serviceCount: number;
    campuses: { id: string; name: string; schoolName: string }[];
    selectedCampusId: string | null;
    userSummary: {
      unreadNotifications: number;
      unreadConversations: number;
      activeOrders: number;
    } | null;
  };
}) {
  return (
    <section className="relative overflow-hidden border-b border-slate-100 bg-gradient-to-br from-indigo-50/40 via-white to-sky-50/20 py-12 md:py-16 lg:py-20 dark:border-slate-900 dark:from-slate-950 dark:via-slate-900 dark:to-indigo-950/10">
      {/* Background aurora glow effects */}
      <div className="absolute left-[-10%] top-[-20%] size-[600px] rounded-full bg-indigo-200/20 blur-[100px] dark:bg-indigo-900/10"></div>
      <div className="absolute right-[-10%] bottom-[-20%] size-[500px] rounded-full bg-sky-200/25 blur-[120px] dark:bg-sky-900/10"></div>

      <div className="relative mx-auto w-full max-w-7xl px-4 sm:px-6">
        <div className="grid gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
          
          {/* Left Column: Headline and Search */}
          <div className="space-y-6 md:space-y-8 animate-slide-up">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-105 bg-indigo-50/50 px-3.5 py-1 text-xs font-semibold text-indigo-700 shadow-sm backdrop-blur-sm dark:border-indigo-900/50 dark:bg-indigo-950/30 dark:text-indigo-400">
              <Sparkles className="size-3.5 text-indigo-500 animate-pulse" />
              校内安全交易与技能互助平台
            </span>

            <div className="space-y-4">
              <h1 className="max-w-2xl text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl md:text-5xl lg:text-[44px] lg:leading-[1.15] dark:text-white">
                校园里的闲置交易、跑腿接单
                <span className="mt-1 block bg-gradient-to-r from-indigo-600 to-sky-500 bg-clip-text text-transparent dark:from-indigo-400 dark:to-sky-400">
                  和技能服务，一站解决
                </span>
              </h1>
              <p className="max-w-xl text-sm leading-relaxed text-slate-505 dark:text-slate-400 md:text-base">
                专为同校师生打造的互信网络。整合了商品买卖、跑腿代办、技能互助等全套校园场景，本地服务，真实高效。
              </p>
            </div>

            {/* Unified Search Console */}
            <div className="rounded-3xl border border-slate-200/80 bg-white p-2 shadow-xl shadow-indigo-900/5 backdrop-blur-md focus-within:border-indigo-400 focus-within:shadow-indigo-500/10 transition-all dark:border-slate-800 dark:bg-slate-900/90 dark:focus-within:border-indigo-500">
              <form action="/search" className="flex flex-col gap-2 sm:flex-row sm:items-center">
                {/* Text query input */}
                <div className="flex flex-1 items-center px-3.5 py-2.5">
                  <Search className="size-4.5 text-slate-400 mr-2.5 shrink-0" />
                  <input
                    name="q"
                    className="w-full bg-transparent text-sm text-slate-800 placeholder-slate-400 outline-none dark:text-slate-100"
                    placeholder="输入商品名称、跑腿任务或技能项目"
                  />
                </div>
                
                {/* Split line */}
                <div className="hidden sm:block h-6 w-px bg-slate-200 dark:bg-slate-800"></div>

                {/* Submits search */}
                <div className="flex items-center gap-2 px-3 sm:px-1">
                  <button
                    type="submit"
                    className="w-full rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-500/25 transition hover:from-indigo-700 hover:to-indigo-800 hover:shadow-lg active:scale-[0.98] dark:from-indigo-500 dark:to-indigo-600"
                  >
                    立即搜索
                  </button>
                </div>
              </form>
            </div>

            {/* Campus Selector Bar & Fast Actions */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-t border-slate-150 pt-5 dark:border-slate-800">
              {/* Campus Selector */}
              <form action="/" className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-white/70 py-1.5 px-3 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
                  <MapPin className="size-4 text-indigo-600 dark:text-indigo-400" />
                  <select
                    name="campus"
                    defaultValue={summary.selectedCampusId ?? ""}
                    onChange={(e) => e.target.form?.submit()}
                    className="bg-transparent text-xs font-semibold text-slate-700 outline-none cursor-pointer dark:text-slate-300"
                  >
                    <option value="">全部校区</option>
                    {summary.campuses.map((campus) => (
                      <option key={campus.id} value={campus.id}>
                        {campus.schoolName} · {campus.name}
                      </option>
                    ))}
                  </select>
                </div>
                {summary.selectedCampusId ? (
                  <Link
                    href="/"
                    className="rounded-2xl border border-slate-200 bg-white/80 py-1.5 px-3 text-xs font-semibold text-slate-500 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60"
                  >
                    查看全部
                  </Link>
                ) : null}
              </form>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href="/products/new"
                  className="inline-flex items-center gap-1 rounded-2xl bg-indigo-50 px-3.5 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 transition shadow-sm dark:bg-indigo-950/40 dark:text-indigo-400"
                >
                  <Plus className="size-3.5" />
                  卖闲置
                </Link>
                <Link
                  href="/errands/new"
                  className="inline-flex items-center gap-1 rounded-2xl bg-sky-50 px-3.5 py-1.5 text-xs font-semibold text-sky-700 hover:bg-sky-100 transition shadow-sm dark:bg-sky-950/40 dark:text-sky-400"
                >
                  <Plus className="size-3.5" />
                  发跑腿
                </Link>
                <Link
                  href="/services/new"
                  className="inline-flex items-center gap-1 rounded-2xl bg-emerald-50 px-3.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 transition shadow-sm dark:bg-emerald-950/40 dark:text-emerald-400"
                >
                  <Plus className="size-3.5" />
                  做服务
                </Link>
              </div>
            </div>

            {/* Quick Link Category Chips */}
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
              {shortcutLinks.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="group flex flex-col gap-1 rounded-2xl border border-slate-150 bg-white p-3.5 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-indigo-200 hover:shadow-md hover:shadow-indigo-500/5 dark:border-slate-800 dark:bg-slate-900/40 dark:hover:border-indigo-950"
                  >
                    <div className="flex items-center justify-between">
                      <div className={`flex size-7.5 items-center justify-center rounded-xl bg-gradient-to-tr ${item.color} text-white shadow-sm`}>
                        <Icon className="size-4" />
                      </div>
                      <ArrowUpRight className="size-3.5 opacity-0 group-hover:opacity-100 text-slate-400 group-hover:text-indigo-600 transition duration-300" />
                    </div>
                    <p className="mt-2.5 text-xs font-bold text-slate-900 dark:text-white transition group-hover:text-indigo-600 dark:group-hover:text-indigo-400">
                      {item.label}
                    </p>
                    <p className="text-[10px] text-slate-450 dark:text-slate-500 leading-tight">
                      {item.description}
                    </p>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Right Column: User Dashboard / Stats Panel */}
          <div className="space-y-6 animate-fade-in lg:mt-2">
            {/* Personal Dashboard */}
            {summary.userSummary ? (
              <div className="rounded-3xl border border-indigo-100 bg-gradient-to-br from-indigo-50/50 to-sky-50/50 p-5 shadow-xl shadow-indigo-900/5 dark:border-indigo-950/40 dark:from-slate-900/90 dark:to-indigo-950/20">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-400">
                    个人快捷看板
                  </p>
                  <span className="flex size-2 rounded-full bg-indigo-500 animate-ping"></span>
                </div>
                <h3 className="mt-2.5 text-lg font-bold text-slate-900 dark:text-white">欢迎回来，开始浏览今天的校园动态</h3>
                
                <div className="mt-4 grid gap-2.5 grid-cols-3">
                  <Link
                    href="/notifications"
                    className="group rounded-2xl bg-white/90 p-3 shadow-sm transition hover:-translate-y-0.5 hover:bg-white hover:shadow-md dark:bg-slate-900/60 dark:hover:bg-slate-900"
                  >
                    <p className="text-[10px] font-semibold text-slate-400">未读通知</p>
                    <p className="mt-1 text-xl font-extrabold text-slate-900 transition group-hover:text-indigo-600 dark:text-white dark:group-hover:text-indigo-400">
                      {summary.userSummary.unreadNotifications}
                    </p>
                  </Link>
                  <Link
                    href="/messages"
                    className="group rounded-2xl bg-white/90 p-3 shadow-sm transition hover:-translate-y-0.5 hover:bg-white hover:shadow-md dark:bg-slate-900/60 dark:hover:bg-slate-900"
                  >
                    <p className="text-[10px] font-semibold text-slate-400">站内消息</p>
                    <p className="mt-1 text-xl font-extrabold text-slate-900 transition group-hover:text-indigo-600 dark:text-white dark:group-hover:text-indigo-400">
                      {summary.userSummary.unreadConversations}
                    </p>
                  </Link>
                  <Link
                    href="/my/orders"
                    className="group rounded-2xl bg-white/90 p-3 shadow-sm transition hover:-translate-y-0.5 hover:bg-white hover:shadow-md dark:bg-slate-900/60 dark:hover:bg-slate-900"
                  >
                    <p className="text-[10px] font-semibold text-slate-400">进行中订单</p>
                    <p className="mt-1 text-xl font-extrabold text-slate-900 transition group-hover:text-indigo-600 dark:text-white dark:group-hover:text-indigo-400">
                      {summary.userSummary.activeOrders}
                    </p>
                  </Link>
                </div>
              </div>
            ) : null}

            {/* Statistics Dashboard Block */}
            <div className="rounded-3xl border border-slate-200/70 bg-white/50 p-5 shadow-xl shadow-slate-900/5 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/40">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-3.5">
                {summary.selectedCampusId ? "本校区概览" : "全站交易概览"}
              </p>
              
              <div className="grid gap-3 grid-cols-2">
                {/* Products Stat */}
                <div className="rounded-2xl bg-gradient-to-br from-indigo-500/10 to-indigo-600/5 border border-indigo-100 p-4 dark:border-indigo-950/40 dark:from-indigo-950/20 dark:to-transparent">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-indigo-700 dark:text-indigo-400 uppercase tracking-wide">二手商品</span>
                    <ProductIcon className="size-4 text-indigo-500" />
                  </div>
                  <p className="mt-3.5 text-2xl font-extrabold text-indigo-950 dark:text-indigo-200">{summary.productCount}</p>
                  <p className="mt-1 text-[9px] text-slate-505 leading-none">
                    {summary.selectedCampusId ? "当前所选校区二手商品数量" : "当前可浏览的二手商品数量"}
                  </p>
                </div>

                {/* Errands Stat */}
                <div className="rounded-2xl bg-gradient-to-br from-sky-500/10 to-sky-600/5 border border-sky-100 p-4 dark:border-sky-950/40 dark:from-sky-950/20 dark:to-transparent">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-sky-700 dark:text-sky-400 uppercase tracking-wide">跑腿任务</span>
                    <ErrandIcon className="size-4 text-sky-500" />
                  </div>
                  <p className="mt-3.5 text-2xl font-extrabold text-sky-950 dark:text-sky-200">{summary.errandCount}</p>
                  <p className="mt-1 text-[9px] text-slate-550 leading-none">
                    {summary.selectedCampusId ? "当前所选校区开放中的跑腿任务数量" : "当前开放中的跑腿任务数量"}
                  </p>
                </div>

                {/* Services Stat */}
                <div className="rounded-2xl bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 border border-emerald-100 p-4 dark:border-emerald-950/40 dark:from-emerald-950/20 dark:to-transparent">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wide">技能服务</span>
                    <ServiceIcon className="size-4 text-emerald-500" />
                  </div>
                  <p className="mt-3.5 text-2xl font-extrabold text-emerald-950 dark:text-emerald-200">{summary.serviceCount}</p>
                  <p className="mt-1 text-[9px] text-slate-550 leading-none">
                    {summary.selectedCampusId ? "当前所选校区可预约的技能服务数量" : "当前可预约的技能服务数量"}
                  </p>
                </div>

                {/* Secure Guarantee */}
                <div className="rounded-2xl bg-gradient-to-br from-purple-500/10 to-purple-600/5 border border-purple-100 p-4 dark:border-purple-950/40 dark:from-purple-950/20 dark:to-transparent">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-purple-700 dark:text-purple-400 uppercase tracking-wide">安全保障</span>
                    <ShieldCheck className="size-4 text-purple-500" />
                  </div>
                  <p className="mt-3.5 text-xs font-bold text-purple-950 leading-tight dark:text-purple-200">同校面交 + 违禁拦截</p>
                  <p className="mt-1.5 text-[9px] text-slate-500 leading-normal">实名校园邮箱认证，规避网络虚假交易</p>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* Highlight Badges */}
        <div className="mt-10 grid gap-3 grid-cols-2 md:grid-cols-4 border-t border-slate-100 pt-6 dark:border-slate-800/80">
          {highlights.map((item) => (
            <div key={item} className="flex items-center gap-2 rounded-xl bg-slate-50/60 px-3 py-2 text-[10px] font-semibold text-slate-650 dark:bg-slate-900/30 dark:text-slate-400">
              <span className="flex size-1.5 shrink-0 rounded-full bg-indigo-500"></span>
              <span className="truncate">{item}</span>
            </div>
          ))}
        </div>

      </div>
    </section>
  );
}
