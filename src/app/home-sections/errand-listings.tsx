import { ListingGrid } from "@/components/site/listing-grid";
import { getHomepageErrands } from "@/repositories/home-repository";

// 跑腿任务两个板块共用一组任务查询,放在同一个 Suspense 边界内一起流入。
export async function HomeErrandListings({ campusId }: { campusId?: string }) {
  const { urgentErrands, highRewardErrands } = await getHomepageErrands({
    campusId,
  });

  return (
    <>
      <ListingGrid
        title="紧急跑腿任务"
        description="优先展示截止更近、需要尽快处理的即时需求。"
        items={urgentErrands}
        moreHref="/errands?deadline=today&sort=deadline_asc"
      />
      <ListingGrid
        title="高赏金任务"
        description="按赏金优先排序，适合有时间时快速挑选更高回报的跑腿单。"
        items={highRewardErrands}
        moreHref="/errands?sort=reward_desc"
      />
    </>
  );
}
