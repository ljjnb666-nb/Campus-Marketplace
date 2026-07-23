"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import {
  User,
  LogOut,
  ChevronDown,
  Package,
  ClipboardList,
  Briefcase,
  FileText,
  Star,
  Flag,
  Heart,
  Shield,
  UserCheck,
  AlertTriangle,
  FolderTree,
  Tag,
  Key,
  CalendarDays,
  Repeat,
} from "lucide-react";

type UserMenuProps = {
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
    role?: string;
  };
  adminNavItems: { href: string; label: string }[];
  accountNavItems: { href: string; label: string }[];
};

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  "我的商品": Package,
  "我的任务": ClipboardList,
  "我的服务": Briefcase,
  "我的订单": FileText,
  "我的评价": Star,
  "我的租用": Key,
  "我的出租": CalendarDays,
  "出租物品": Repeat,
  "举报中心": Flag,
  "个人中心": User,
  "我的收藏": Heart,
  "后台总览": Shield,
  "认证审核": UserCheck,
  "举报处理": AlertTriangle,
  "分类管理": FolderTree,
  "关键词管理": Tag,
};

export function UserMenu({ user, adminNavItems, accountNavItems }: UserMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const displayName = user.name || "校园用户";
  const avatarInitial = displayName[0]?.toUpperCase() || "用";

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white/90 py-1.5 pl-3 pr-2.5 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-indigo-300 hover:bg-slate-50 focus:outline-none dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
      >
        {user.image ? (
          <img
            src={user.image}
            alt={displayName}
            className="size-7 rounded-full object-cover"
          />
        ) : (
          <div className="flex size-7 items-center justify-center rounded-full bg-gradient-to-tr from-indigo-500 to-sky-500 text-xs font-bold text-white shadow-inner">
            {avatarInitial}
          </div>
        )}
        <span className="max-w-[100px] truncate">{displayName}</span>
        <ChevronDown
          className={`size-4 text-slate-500 transition-transform duration-300 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2.5 w-64 origin-top-right rounded-3xl border border-slate-200/80 bg-white/95 p-2.5 shadow-2xl shadow-slate-900/10 backdrop-blur-xl transition-all animate-scale-in dark:border-slate-800 dark:bg-slate-950">
          <div className="flex items-center gap-3 border-b border-slate-100 px-3 pb-3 pt-2 dark:border-slate-900">
            {user.image ? (
              <img
                src={user.image}
                alt={displayName}
                className="size-10 rounded-2xl object-cover shadow-md"
              />
            ) : (
              <div className="flex size-10 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 to-indigo-700 font-bold text-white shadow-md shadow-indigo-500/20">
                {avatarInitial}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-slate-900 dark:text-white">
                {displayName}
              </p>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span
                  className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold border ${
                    user.role === "ADMIN"
                      ? "border-amber-300/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                      : "border-indigo-300/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400"
                  }`}
                >
                  {user.role === "ADMIN" ? "系统管理员" : "已认证学生"}
                </span>
              </div>
            </div>
          </div>

          <div className="max-h-[380px] overflow-y-auto scrollbar-hide py-1.5 space-y-1">
            {adminNavItems.length > 0 && (
              <div className="px-1 py-1">
                <p className="px-2 text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                  系统管理后台
                </p>
                <div className="mt-1 space-y-0.5">
                  {adminNavItems.map((item) => {
                    const Icon = iconMap[item.label] || Shield;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setIsOpen(false)}
                        className="flex items-center gap-2.5 rounded-2xl px-2.5 py-2 text-xs font-semibold text-amber-950 transition hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-200 dark:hover:bg-amber-500/20"
                      >
                        <Icon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="px-1">
              <p className="px-2 text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                个人服务中心
              </p>
              <div className="mt-1 grid grid-cols-2 gap-0.5">
                {accountNavItems.map((item) => {
                  const Icon = iconMap[item.label] || User;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setIsOpen(false)}
                      className="flex items-center gap-2 rounded-2xl px-2.5 py-2 text-xs font-medium text-slate-700 transition hover:bg-indigo-50 hover:text-indigo-700 dark:text-slate-300 dark:hover:bg-indigo-950/40 dark:hover:text-indigo-400"
                    >
                      <Icon className="size-4 shrink-0 text-slate-400 group-hover:text-indigo-600 dark:text-slate-500" />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="mt-1.5 border-t border-slate-100 p-1 dark:border-slate-900">
            <button
              onClick={() => {
                setIsOpen(false);
                signOut({ callbackUrl: "/login" });
              }}
              className="flex w-full items-center gap-2.5 rounded-2xl px-3 py-2 text-xs font-semibold text-red-600 transition hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
            >
              <LogOut className="size-4 shrink-0" />
              <span>退出登录</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
