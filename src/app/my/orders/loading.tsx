import { Skeleton } from "@/components/ui/loading-skeleton";

export default function MyOrdersLoading() {
  return (
    <div
      className="flex min-h-[60vh] items-center justify-center px-4"
      aria-busy="true"
      aria-label="订单加载中"
    >
      <div className="w-full max-w-3xl space-y-4">
        <Skeleton className="mx-auto h-8 w-48" />
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-24 w-11/12 rounded-2xl" />
      </div>
    </div>
  );
}
