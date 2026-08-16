import { HeroSection } from "@/components/site/hero";
import { auth } from "@/lib/auth";
import { getHomepageSummary } from "@/repositories/home-repository";

// 首屏摘要区(hero):校区选择、交易概览与个人看板都依赖登录态和实时计数,
// 单独挂在 Suspense 边界内,登录态查询不再阻塞页面外壳的首字节输出。
export async function HomeHeroSummary({ campusId }: { campusId?: string }) {
  const session = await auth();
  const summary = await getHomepageSummary({
    userId: session?.user?.id,
    campusId,
  });

  return <HeroSection summary={summary} />;
}
