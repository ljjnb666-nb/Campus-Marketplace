import { Skeleton } from "@/components/ui/loading-skeleton";

export default function MessagesLoading() {
  return (
    <div
      className="flex min-h-[60vh] items-center justify-center px-4"
      aria-busy="true"
      aria-label="消息中心加载中"
    >
      <div className="w-full max-w-lg space-y-4">
        <Skeleton className="mx-auto h-7 w-44" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-11/12" />
        <Skeleton className="h-14 w-full" />
      </div>
    </div>
  );
}
