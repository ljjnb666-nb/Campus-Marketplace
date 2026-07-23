 
import Link from "next/link";
import { PRODUCT_STATUS_LABELS } from "@/constants/product";
import { Heart, User, Folder } from "lucide-react";
import { PriceDisplay } from "@/components/ui/price-display";
import { StatusBadge } from "@/components/ui/status-badge";

type ProductCardProps = {
  id: string;
  title: string;
  description: string;
  price: string | number;
  status: keyof typeof PRODUCT_STATUS_LABELS;
  category: string;
  seller: string;
  imageUrl?: string;
  favoriteCount?: number;
  reason?: string;
};

export function ProductCard({
  id,
  title,
  description,
  price,
  status,
  category,
  seller,
  imageUrl,
  favoriteCount = 0,
  reason,
}: ProductCardProps) {
  const isStatusActive = status === "ACTIVE";

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-xs transition-all duration-300 hover:-translate-y-1 hover:border-indigo-200 hover:shadow-md dark:border-slate-800 dark:bg-slate-900">
      <Link href={`/products/${id}`} className="flex flex-col h-full">
        {/* 封面图容器 */}
        <div className="relative aspect-4/3 w-full overflow-hidden bg-slate-100 dark:bg-slate-800">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={title}
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">
              无商品图片
            </div>
          )}
          <div className="absolute left-2.5 top-2.5">
            <StatusBadge
              label={PRODUCT_STATUS_LABELS[status] || status}
              variant={isStatusActive ? "success" : "neutral"}
              size="sm"
            />
          </div>
        </div>

        {/* 内容区域 */}
        <div className="flex flex-1 flex-col p-3.5 space-y-2">
          <div className="flex items-center gap-1.5 text-[10px] font-medium text-slate-500">
            <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <Folder className="size-3 text-slate-400" />
              {category}
            </span>
            {reason && (
              <span className="rounded-md bg-amber-50 px-2 py-0.5 text-amber-700 border border-amber-200/50 dark:bg-amber-950/40 dark:text-amber-300">
                {reason}
              </span>
            )}
          </div>

          <h3 className="text-sm sm:text-base font-bold text-slate-900 line-clamp-1 group-hover:text-indigo-600 transition duration-200 dark:text-slate-100 dark:group-hover:text-indigo-400">
            {title}
          </h3>

          <p className="line-clamp-2 text-xs text-slate-500 leading-relaxed dark:text-slate-400 flex-1">
            {description}
          </p>

          <div className="flex items-center justify-between border-t border-slate-100 pt-3 dark:border-slate-800">
            <PriceDisplay price={price} size="sm" />
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 truncate max-w-[90px]">
              <User className="size-3 text-slate-400 shrink-0" />
              <span className="truncate">{seller}</span>
            </span>
          </div>

          <div className="flex items-center justify-between text-[10px] text-slate-400 pt-0.5">
            <span className="inline-flex items-center gap-1">
              <Heart className={`size-3 ${favoriteCount > 0 ? "fill-rose-500 text-rose-500" : ""}`} />
              <span>{favoriteCount} 收藏</span>
            </span>
            <span className="font-semibold text-indigo-600 group-hover:translate-x-0.5 transition-transform dark:text-indigo-400">
              详情 →
            </span>
          </div>
        </div>
      </Link>
    </article>
  );
}

