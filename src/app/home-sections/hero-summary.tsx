import { HeroSection } from "@/components/site/hero";
import { getActiveViewerId } from "@/lib/server-auth";
import { getHomepageSummary } from "@/repositories/home-repository";

// 首屏摘要区(hero):校区选择、交易概览与个人看板都依赖登录态和实时计数,
// 单独挂在 Suspense 边界内,登录态查询不再阻塞页面外壳的首字节输出。
export async function HomeHeroSummary({ campusId }: { campusId?: string }) {
  // Phase 6C-2 raw-auth hardening：个人看板计数是私有个性化，必须 ACTIVE
  // 账号 DB 复查；SUSPENDED 会话退化为匿名语义（公共概览仍渲染）。
  const viewerId = await getActiveViewerId();
  const summary = await getHomepageSummary({
    userId: viewerId ?? undefined,
    campusId,
  });

  return <HeroSection summary={summary} />;
}
