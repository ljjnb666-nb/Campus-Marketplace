import { PageContainer } from "@/components/ui/page-container";
import { CardGridSkeleton, Skeleton } from "@/components/ui/loading-skeleton";

export default function ProductsLoading() {
  return (
    <PageContainer maxWidth="wide" aria-busy="true" aria-label="商品列表加载中">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="mt-3 h-4 w-full max-w-2xl" />
      <Skeleton className="mt-8 h-12 w-full rounded-2xl" />
      <div className="mt-8">
        <CardGridSkeleton count={8} />
      </div>
    </PageContainer>
  );
}
