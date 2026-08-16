import { CardGridSkeleton, Skeleton } from "@/components/ui/loading-skeleton";

export default function RootLoading() {
  return (
    <div
      className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8"
      aria-busy="true"
      aria-label="页面加载中"
    >
      <Skeleton className="h-8 w-56" />
      <Skeleton className="mt-4 h-4 w-full max-w-xl" />
      <div className="mt-10">
        <CardGridSkeleton count={8} />
      </div>
    </div>
  );
}
