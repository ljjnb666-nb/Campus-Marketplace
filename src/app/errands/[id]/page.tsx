import React from "react";
import { PageContainer } from "@/components/ui/page-container";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { ErrandCard } from "@/components/errand/errand-card";
import { ErrandDetailConsole } from "@/components/errand/errand-detail-console";
import { auth } from "@/lib/auth";
import { getErrandDetail } from "@/repositories/errand-repository";
import { MapPin, Navigation, Info, ShieldAlert } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ErrandDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  const { errand, relatedErrands } = await getErrandDetail(id);
  const isPublisher = session?.user?.id === errand.publisherId;
  const isAccepter = session?.user?.id === errand.accepterId;

  const availableActions = isPublisher
    ? [
        ...(errand.status === "OPEN" ? [{ status: "CANCELLED" as const, label: "取消任务" }] : []),
        ...(errand.status === "PENDING_CONFIRMATION"
          ? [{ status: "COMPLETED" as const, label: "确认完成" }]
          : []),
        ...(errand.status === "CLAIMED" && errand.accepterId
          ? [{ status: "OPEN" as const, label: "撤销接单" }]
          : []),
      ]
    : isAccepter
      ? [
          ...(errand.status === "CLAIMED"
            ? [{ status: "IN_PROGRESS" as const, label: "开始任务" }]
            : []),
          ...(errand.status === "IN_PROGRESS"
            ? [{ status: "PENDING_CONFIRMATION" as const, label: "提交完成" }]
            : []),
        ]
      : [];

  return (
    <PageContainer maxWidth="standard">
      {/* 1. 面包屑导航 */}
      <Breadcrumbs
        items={[
          { label: "跑腿求助大厅", href: "/errands" },
          { label: errand.category.name, href: `/errands?category=${errand.categoryId}` },
          { label: errand.title },
        ]}
      />

      {/* 2. 主从双栏：55% 左侧路线与描述 + 45% Sticky 右侧控制台 */}
      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
        {/* 左侧：路线图 + 详细说明 + 提示 + 为你推荐 */}
        <div className="space-y-8">
          {/* 跑腿路线高亮面板 */}
          <div className="rounded-3xl border border-slate-200/80 bg-gradient-to-br from-indigo-50/50 via-white to-sky-50/50 p-6 sm:p-8 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4">
              跑腿取送路线详情
            </h2>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <div className="flex size-10 items-center justify-center rounded-2xl bg-indigo-600 text-white font-bold text-sm shrink-0">
                  <MapPin className="size-5" />
                </div>
                <div className="min-w-0 space-y-0.5">
                  <span className="text-[10px] font-bold text-indigo-600 uppercase">起点（取件位置）</span>
                  <p className="text-base font-bold text-slate-900 truncate dark:text-slate-100">
                    {errand.pickupLocation}
                  </p>
                </div>
              </div>

              <div className="hidden sm:flex flex-col items-center px-4 text-slate-300">
                <span className="text-[10px] font-bold text-slate-400">递送中</span>
                <span className="text-sm">➔</span>
              </div>

              <div className="flex items-start gap-3 flex-1 min-w-0">
                <div className="flex size-10 items-center justify-center rounded-2xl bg-emerald-600 text-white font-bold text-sm shrink-0">
                  <Navigation className="size-5" />
                </div>
                <div className="min-w-0 space-y-0.5">
                  <span className="text-[10px] font-bold text-emerald-600 uppercase">终点（送达位置）</span>
                  <p className="text-base font-bold text-slate-900 truncate dark:text-slate-100">
                    {errand.deliveryLocation}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* 详细描述 */}
          <section className="space-y-4 rounded-3xl border border-slate-200/80 bg-white p-6 sm:p-8 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2 border-b border-slate-100 pb-3 dark:border-slate-800">
              <Info className="size-4 text-indigo-600" />
              任务要求与补充说明
            </h2>
            <div className="prose prose-slate max-w-none text-sm leading-relaxed whitespace-pre-wrap text-slate-700 dark:text-slate-300">
              {errand.description}
            </div>

            {errand.contactNote && (
              <div className="mt-4 rounded-2xl bg-slate-50 p-4 border border-slate-100 text-xs text-slate-600 dark:bg-slate-950/40 dark:border-slate-800">
                <span className="font-bold text-slate-900 dark:text-slate-200">联系补充说明：</span>
                {errand.contactNote}
              </div>
            )}
          </section>

          {/* 平台安全提示 */}
          <div className="flex items-start gap-3 rounded-3xl border border-amber-200/60 bg-amber-50/50 p-5 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
            <ShieldAlert className="size-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold">校园同校跑腿安全提示</p>
              <p className="text-amber-800/80 dark:text-amber-300/80 leading-relaxed">
                平台鼓励同校学生互帮互助。取送物品前请核对物品完好程度，涉及高价值物品请当面确认清楚。
              </p>
            </div>
          </div>

          {/* 推荐跑腿任务 */}
          {relatedErrands.length > 0 && (
            <section className="space-y-4 pt-4">
              <div className="flex items-end justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
                <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-slate-100">
                  为你推荐同校跑腿任务
                </h2>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {relatedErrands.map((item) => (
                  <ErrandCard
                    key={item.id}
                    id={item.id}
                    title={item.title}
                    reward={item.reward.toString()}
                    pickupLocation={item.pickupLocation}
                    deliveryLocation={item.deliveryLocation}
                    publisher={item.publisher.name}
                    status={item.status}
                    reason={item.reason}
                  />
                ))}
              </div>
            </section>
          )}
        </div>

        {/* 右侧：Sticky 控制台 */}
        <ErrandDetailConsole
          errand={{
            ...errand,
            reward: errand.reward.toString(),
            advanceAmount: errand.advanceAmount ? errand.advanceAmount.toString() : null,
            accepter: errand.accepter
              ? {
                  ...errand.accepter,
                  schoolName: errand.publisher.schoolName || "认证校区",
                  completedOrdersCount: 0,
                  createdAt: new Date(),
                }
              : null,
          }}
          isPublisher={isPublisher}
          isAccepter={isAccepter}
          isLoggedIn={!!session?.user}
          availableActions={availableActions}
        />
      </div>
    </PageContainer>
  );
}
