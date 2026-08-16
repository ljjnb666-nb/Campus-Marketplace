import { Skeleton } from "@/components/ui/loading-skeleton";

export default function AdminLoading() {
  return (
    <div
      className="flex min-h-[60vh] items-center justify-center px-4"
      aria-busy="true"
      aria-label="管理后台加载中"
    >
      <div className="w-full max-w-4xl space-y-4">
        <Skeleton className="mx-auto h-8 w-44" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Skeleton className="h-20 rounded-2xl" />
          <Skeleton className="h-20 rounded-2xl" />
          <Skeleton className="h-20 rounded-2xl" />
        </div>
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
    </div>
  );
}
