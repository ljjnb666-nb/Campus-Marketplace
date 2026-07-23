import Link from "next/link";
import { ERRAND_STATUS_LABELS } from "@/constants/errand";
import { MapPin, Navigation, User } from "lucide-react";
import { PriceDisplay } from "@/components/ui/price-display";
import { StatusBadge } from "@/components/ui/status-badge";

type ErrandCardProps = {
  id: string;
  title: string;
  reward: string;
  pickupLocation: string;
  deliveryLocation: string;
  publisher: string;
  status: keyof typeof ERRAND_STATUS_LABELS;
  reason?: string;
};

export function ErrandCard({
  id,
  title,
  reward,
  pickupLocation,
  deliveryLocation,
  publisher,
  status,
  reason,
}: ErrandCardProps) {
  const isOpen = status === "OPEN";
  const isInProgress = status === "CLAIMED" || status === "IN_PROGRESS" || status === "PENDING_CONFIRMATION";
  const isCompleted = status === "COMPLETED";

  const badgeVariant = isOpen
    ? "warning"
    : isInProgress
    ? "primary"
    : isCompleted
    ? "success"
    : "neutral";

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs transition-all duration-300 hover:-translate-y-1 hover:border-indigo-200 hover:shadow-md dark:border-slate-800 dark:bg-slate-900">
      <Link href={`/errands/${id}`} className="flex flex-col h-full gap-3">
        {/* 顶部标签 */}
        <div className="flex items-center justify-between gap-2">
          <StatusBadge
            label={ERRAND_STATUS_LABELS[status] || status}
            variant={badgeVariant}
            size="sm"
            dot
          />
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 truncate max-w-[100px]">
            <User className="size-3 text-slate-400 shrink-0" />
            <span className="truncate">{publisher}</span>
          </span>
        </div>

        {reason && (
          <div>
            <span className="rounded-md bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700 border border-sky-200/50 dark:bg-sky-950/40 dark:text-sky-300">
              {reason}
            </span>
          </div>
        )}

        {/* 标题 */}
        <h3 className="text-sm sm:text-base font-bold text-slate-900 line-clamp-1 group-hover:text-indigo-600 transition duration-200 dark:text-slate-100 dark:group-hover:text-indigo-400">
          {title}
        </h3>

        {/* 路线地点卡片 */}
        <div className="flex-1 rounded-xl bg-slate-50/80 p-2.5 space-y-1.5 text-xs dark:bg-slate-950/40">
          <div className="flex items-center gap-2">
            <MapPin className="size-3.5 text-indigo-500 shrink-0" />
            <span className="truncate text-slate-700 dark:text-slate-300 font-medium">
              取：{pickupLocation}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Navigation className="size-3.5 text-emerald-500 shrink-0" />
            <span className="truncate text-slate-900 dark:text-slate-100 font-bold">
              送：{deliveryLocation}
            </span>
          </div>
        </div>

        {/* 底部悬赏金额 */}
        <div className="flex items-center justify-between border-t border-slate-100 pt-2.5 dark:border-slate-800">
          <span className="text-xs text-slate-500 font-medium">跑腿悬赏</span>
          <PriceDisplay price={reward} size="md" />
        </div>
      </Link>
    </article>
  );
}
