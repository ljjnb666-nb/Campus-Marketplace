"use client";

 
import Link from "next/link";
import { useMemo, useState } from "react";
import { Folder, Sparkles, ArrowRight, Zap } from "lucide-react";

type ListingCard = {
  id: string;
  href: string;
  title: string;
  subtitle: string;
  price: string;
  meta: string;
  reason?: string;
  imageUrl?: string | null;
};

const PAGE_SIZE = 3;

function ErrandPlaceholder() {
  return (
    <div className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-tr from-sky-400/20 via-indigo-400/10 to-amber-300/10 p-5 dark:from-sky-950/20 dark:via-indigo-950/10 dark:to-transparent border border-slate-100 dark:border-slate-800/80">
      <div className="absolute top-[-20%] right-[-10%] size-28 rounded-full bg-sky-400/10 blur-xl"></div>
      <div className="flex flex-col items-center text-center space-y-2.5">
        <div className="flex size-11 items-center justify-center rounded-2xl bg-gradient-to-tr from-sky-500 to-indigo-500 text-white shadow-md shadow-sky-500/25 animate-pulse">
          <Zap className="size-5 fill-white/10" />
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-sky-700 dark:text-sky-400">
            CAMPUS SERVICE
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            即时跑腿与同校服务对接
          </p>
        </div>
      </div>
    </div>
  );
}

export function ListingGrid({
  title,
  description,
  items,
  moreHref,
  moreLabel = "查看更多",
}: {
  title: string;
  description: string;
  items: ListingCard[];
  moreHref?: string;
  moreLabel?: string;
}) {
  const [pageIndex, setPageIndex] = useState(0);

  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));

  const visibleItems = useMemo(() => {
    const start = pageIndex * PAGE_SIZE;
    return items.slice(start, start + PAGE_SIZE);
  }, [items, pageIndex]);

  function handleNextPage() {
    setPageIndex((current) => (current + 1) % pageCount);
  }

  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:py-10">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">{title}</h2>
          <p className="text-xs text-slate-505 dark:text-slate-400">{description}</p>
        </div>
        
        {/* Actions button */}
        <div className="flex items-center gap-2">
          {items.length > PAGE_SIZE ? (
            <button
              type="button"
              onClick={handleNextPage}
              className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 shadow-sm transition hover:bg-slate-50 active:scale-[0.98] dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
            >
              换一批
            </button>
          ) : null}
          {moreHref ? (
            <Link
              href={moreHref}
              className="inline-flex items-center gap-1 shrink-0 rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 py-2 text-xs font-bold text-white shadow-md shadow-indigo-500/10 transition hover:from-indigo-700 hover:to-indigo-800 active:scale-[0.98] dark:from-indigo-500 dark:to-indigo-600"
            >
              <span>{moreLabel}</span>
              <ArrowRight className="size-3" />
            </Link>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {visibleItems.map((item) => (
          <article
            key={item.id}
            className="group relative rounded-3xl border border-slate-150 bg-white p-4.5 shadow-sm transition-all duration-300 hover:-translate-y-1.5 hover:border-indigo-200 hover:shadow-xl hover:shadow-indigo-500/5 dark:border-slate-850 dark:bg-slate-900/40 dark:hover:border-indigo-950"
          >
            <Link href={item.href} className="block space-y-3.5">
              
              {/* Media area */}
              <div className="overflow-hidden rounded-2xl bg-slate-100 dark:bg-slate-800">
                {item.imageUrl ? (
                  <div className="relative aspect-[4/3] overflow-hidden">
                    <img
                      src={item.imageUrl}
                      alt={item.title}
                      className="size-full object-cover transition-transform duration-500 group-hover:scale-105"
                    />
                  </div>
                ) : (
                  <ErrandPlaceholder />
                )}
              </div>

              {/* Detail information */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold text-slate-500">
                  <span className="inline-flex items-center gap-1 rounded-lg border border-indigo-100 bg-indigo-50/40 px-2 py-0.5 text-indigo-700 dark:border-indigo-950 dark:bg-indigo-950/20 dark:text-indigo-400">
                    <Folder className="size-3" />
                    {item.meta}
                  </span>
                  {item.reason ? (
                    <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2 py-0.5 text-emerald-700 border border-emerald-100 dark:bg-emerald-950/20 dark:text-emerald-400 dark:border-emerald-900/30">
                      <Sparkles className="size-3 text-emerald-500" />
                      {item.reason}
                    </span>
                  ) : null}
                </div>

                <h3 className="text-base font-bold text-slate-950 line-clamp-1 group-hover:text-indigo-600 transition duration-300 dark:text-white dark:group-hover:text-indigo-400">
                  {item.title}
                </h3>
                <p className="line-clamp-2 text-xs text-slate-505 dark:text-slate-400 leading-relaxed">
                  {item.subtitle}
                </p>

                <div className="flex items-center justify-between border-t border-slate-100 pt-3 dark:border-slate-800/80">
                  {/* Price */}
                  <span className="text-lg font-black text-slate-950 dark:text-white bg-gradient-to-r from-slate-950 to-slate-800 dark:from-white dark:to-slate-200 bg-clip-text">
                    {item.price}
                  </span>
                  
                  {/* Action Link indicator */}
                  <span className="text-[10px] font-bold text-indigo-600 group-hover:text-indigo-500 transition-colors">
                    立即查看 →
                  </span>
                </div>
              </div>

            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}

