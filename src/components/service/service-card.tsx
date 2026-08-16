import Link from "next/link";
import { SERVICE_PRICING_UNIT_LABELS, SERVICE_STATUS_LABELS } from "@/constants/service";
import { User, MapPin, CheckSquare, Sparkles, Folder } from "lucide-react";
import { PriceDisplay } from "@/components/ui/price-display";
import { StatusBadge } from "@/components/ui/status-badge";

type ServiceCardProps = {
  id: string;
  title: string;
  description: string;
  price: string | number;
  pricingUnit: keyof typeof SERVICE_PRICING_UNIT_LABELS;
  status: keyof typeof SERVICE_STATUS_LABELS;
  provider: string;
  locationText: string;
  categoryName?: string;
  coverImageUrl?: string | null;
  completedOrderCount?: number;
  reason?: string;
};

export function ServiceCard({
  id,
  title,
  description,
  price,
  pricingUnit,
  status,
  provider,
  locationText,
  categoryName,
  coverImageUrl,
  completedOrderCount = 0,
  reason,
}: ServiceCardProps) {
  const isStatusActive = status === "ACTIVE";

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-xs transition-all duration-300 hover:-translate-y-1 hover:border-indigo-200 hover:shadow-md dark:border-slate-800 dark:bg-slate-900">
      <Link href={`/services/${id}`} className="flex flex-col h-full">
        {/* 封面图容器 */}
        <div className="relative aspect-4/3 w-full overflow-hidden bg-slate-100 dark:bg-slate-800">
          {coverImageUrl ? (
            <img
              src={coverImageUrl}
              alt={title}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">
              无服务展示图
            </div>
          )}
          <div className="absolute left-2.5 top-2.5">
            <StatusBadge
              label={SERVICE_STATUS_LABELS[status] || status}
              variant={isStatusActive ? "success" : "neutral"}
              size="sm"
            />
          </div>
        </div>

        {/* 内容区域 */}
        <div className="flex flex-1 flex-col p-3.5 space-y-2">
          <div className="flex items-center gap-1.5 text-[10px] font-medium text-slate-500">
            {categoryName && (
              <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                <Folder className="size-3 text-slate-400" />
                {categoryName}
              </span>
            )}
            {reason && (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-emerald-700 border border-emerald-200/50 dark:bg-emerald-950/40 dark:text-emerald-300">
                <Sparkles className="size-3 text-emerald-500" />
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

          <div className="flex items-center justify-between text-[11px] font-medium text-slate-500 pt-1">
            <span className="inline-flex items-center gap-1 truncate max-w-[100px]">
              <User className="size-3 text-slate-400 shrink-0" />
              <span className="truncate">{provider}</span>
            </span>
            <span className="inline-flex items-center gap-1 truncate max-w-[100px]">
              <MapPin className="size-3 text-slate-400 shrink-0" />
              <span className="truncate">{locationText}</span>
            </span>
          </div>

          <div className="flex items-center justify-between border-t border-slate-100 pt-2.5 dark:border-slate-800">
            <PriceDisplay
              price={price}
              unit={SERVICE_PRICING_UNIT_LABELS[pricingUnit]}
              size="sm"
            />
            <span className="inline-flex items-center gap-1 rounded-md bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <CheckSquare className="size-3 text-indigo-500" />
              已接 {completedOrderCount} 单
            </span>
          </div>
        </div>
      </Link>
    </article>
  );
}
