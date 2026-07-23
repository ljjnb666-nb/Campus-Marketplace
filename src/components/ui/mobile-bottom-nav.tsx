"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, ShoppingBag, PlusCircle, Repeat, User } from "lucide-react";
import { cn } from "@/lib/utils";

export function MobileBottomNav() {
  const pathname = usePathname();

  // 如果在聊天或详情沉浸页，可保持底栏精简
  const navItems = [
    { href: "/", label: "首页", icon: Home },
    { href: "/products", label: "二手集市", icon: ShoppingBag },
    { href: "/products/new", label: "发布", icon: PlusCircle, isPrimary: true },
    { href: "/rentals", label: "租赁", icon: Repeat },
    { href: "/profile", label: "我的", icon: User },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 block border-t border-slate-200/80 bg-white/95 backdrop-blur-xl lg:hidden dark:border-slate-800 dark:bg-slate-950/95 pb-[env(safe-area-inset-bottom)]">
      <div className="grid h-14 grid-cols-5 items-center px-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));

          if (item.isPrimary) {
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-col items-center justify-center -mt-4"
              >
                <div className="flex size-11 items-center justify-center rounded-full bg-gradient-to-r from-indigo-600 to-indigo-700 text-white shadow-lg shadow-indigo-600/30 transition hover:scale-105 active:scale-95">
                  <Icon className="size-6 stroke-[2.2]" />
                </div>
                <span className="mt-0.5 text-[10px] font-bold text-indigo-600">{item.label}</span>
              </Link>
            );
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center justify-center py-1 transition-colors",
                isActive
                  ? "text-indigo-600 font-bold dark:text-indigo-400"
                  : "text-slate-500 font-medium hover:text-slate-900 dark:text-slate-400"
              )}
            >
              <Icon className={cn("size-5", isActive && "stroke-[2.2]")} />
              <span className="mt-1 text-[10px]">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
