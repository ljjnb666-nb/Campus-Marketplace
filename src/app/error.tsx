"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[640px] w-full max-w-6xl items-center px-4 py-16 sm:px-6">
      <section className="relative w-full overflow-hidden rounded-[40px] border border-slate-200 bg-white p-8 shadow-sm sm:p-12">
        <div className="absolute -right-24 -top-24 size-64 rounded-full bg-slate-100" />
        <div className="absolute -bottom-32 left-20 size-72 rounded-full bg-amber-100/60" />

        <div className="relative max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-[0.32em] text-slate-400">
            出错啦 / 加载中断
          </p>
          <h1 className="mt-5 text-4xl font-semibold tracking-tight text-slate-950 sm:text-6xl">
            出错了
          </h1>
          <p className="mt-5 text-base leading-7 text-slate-600 sm:text-lg">
            页面加载失败，请稍后重试。你可以重新加载当前页面，或回到首页继续浏览校园集市。
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => reset()}
              className="rounded-full bg-slate-950 px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              重试
            </button>
            <Link
              href="/"
              className="rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
            >
              回到首页
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
