import { Skeleton } from "@/components/ui/loading-skeleton";

export default function OrderMeetupLoading() {
  return (
    <div
      className="flex min-h-[60vh] items-center justify-center px-4"
      aria-busy="true"
      aria-label="见面约定加载中"
    >
      <div className="w-full max-w-2xl space-y-4">
        <Skeleton className="mx-auto h-8 w-40" />
        <Skeleton className="h-28 w-full rounded-3xl" />
        <Skeleton className="h-48 w-full rounded-3xl" />
        <Skeleton className="h-36 w-11/12 rounded-3xl" />
      </div>
    </div>
  );
}
