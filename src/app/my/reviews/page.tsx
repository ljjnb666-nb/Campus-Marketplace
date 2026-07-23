import { requireUser } from "@/lib/server-auth";
import { getMyReviews } from "@/repositories/trust-repository";

export const dynamic = "force-dynamic";

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export default async function MyReviewsPage() {
  const user = await requireUser();
  const { writtenReviews, receivedReviews } = await getMyReviews(user.id);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">我的评价</h1>
        <p className="mt-2 text-sm text-slate-600">查看你写出的评价，以及别人给你的评价。</p>
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="mb-4 text-2xl font-semibold text-slate-950">我写出的评价</h2>
          <div className="grid gap-4">
            {writtenReviews.length === 0 ? (
              <div className="rounded-[24px] border border-slate-200 bg-white p-6 text-sm text-slate-500">
                你还没有提交过评价。
              </div>
            ) : (
              writtenReviews.map((review) => (
                <article key={review.id} className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
                  <p className="text-sm text-slate-500">
                    订单 {review.order.orderNo} · {review.order.type}
                  </p>
                  <h3 className="mt-2 text-lg font-semibold text-slate-950">{review.targetUser.name}</h3>
                  <p className="mt-2 text-sm text-slate-600">评分：{review.rating} / 5</p>
                  <p className="mt-2 text-sm text-slate-600">{review.content ?? "未填写文字评价。"}</p>
                  <p className="mt-2 text-xs text-slate-500">提交时间：{formatDate(review.createdAt)}</p>
                </article>
              ))
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-2xl font-semibold text-slate-950">我收到的评价</h2>
          <div className="grid gap-4">
            {receivedReviews.length === 0 ? (
              <div className="rounded-[24px] border border-slate-200 bg-white p-6 text-sm text-slate-500">
                你暂时还没有收到评价。
              </div>
            ) : (
              receivedReviews.map((review) => (
                <article key={review.id} className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
                  <p className="text-sm text-slate-500">
                    订单 {review.order.orderNo} · {review.order.type}
                  </p>
                  <h3 className="mt-2 text-lg font-semibold text-slate-950">{review.author.name}</h3>
                  <p className="mt-2 text-sm text-slate-600">评分：{review.rating} / 5</p>
                  <p className="mt-2 text-sm text-slate-600">{review.content ?? "对方未填写文字评价。"}</p>
                  <p className="mt-2 text-xs text-slate-500">提交时间：{formatDate(review.createdAt)}</p>
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
