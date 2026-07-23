import Link from "next/link";
import { deleteErrand } from "@/actions/errand";
import { ERRAND_STATUS_LABELS } from "@/constants/errand";
import { requireUser } from "@/lib/server-auth";
import {
  getMyAcceptedErrands,
  getMyPublishedErrands,
} from "@/repositories/errand-repository";

export const dynamic = "force-dynamic";

export default async function MyErrandsPage() {
  const user = await requireUser();
  const [publishedErrands, acceptedErrands] = await Promise.all([
    getMyPublishedErrands(user.id),
    getMyAcceptedErrands(user.id),
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-slate-950">我的任务</h1>
          <p className="mt-2 text-sm text-slate-600">
            同时查看自己发布的任务和自己接下的任务。
          </p>
        </div>
        <Link
          href="/errands/new"
          className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          发布任务
        </Link>
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="mb-4 text-2xl font-semibold text-slate-950">我发布的任务</h2>
          <div className="grid gap-4">
            {publishedErrands.length === 0 ? (
              <div className="rounded-[24px] border border-slate-200 bg-white p-6 text-sm text-slate-500">
                你还没有发布任务。
              </div>
            ) : (
              publishedErrands.map((errand) => (
                <article
                  key={errand.id}
                  className="rounded-[24px] border border-slate-200 bg-white p-5"
                >
                  <div className="flex items-center justify-between gap-3 text-sm text-slate-500">
                    <span>{ERRAND_STATUS_LABELS[errand.status]}</span>
                    <span>{errand.accepter?.name ?? "暂无接单人"}</span>
                  </div>
                  <h3 className="mt-2 text-lg font-semibold text-slate-950">{errand.title}</h3>
                  <p className="mt-2 text-sm text-slate-600">
                    {errand.pickupLocation} -&gt; {errand.deliveryLocation}
                  </p>
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <span className="text-lg font-semibold text-slate-950">
                      ¥{errand.reward.toString()}
                    </span>
                    <div className="flex flex-wrap gap-3">
                      <Link
                        href={`/errands/${errand.id}`}
                        className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                      >
                        查看详情
                      </Link>
                      {errand.status === "OPEN" ? (
                        <Link
                          href={`/errands/${errand.id}/edit`}
                          className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                        >
                          编辑
                        </Link>
                      ) : null}
                      {errand.status === "OPEN" || errand.status === "CANCELLED" ? (
                        <form action={deleteErrand}>
                          <input type="hidden" name="errandId" value={errand.id} />
                          <button
                            type="submit"
                            className="rounded-full border border-rose-200 px-4 py-2 text-sm font-medium text-rose-700 transition hover:border-rose-300 hover:text-rose-800"
                          >
                            删除
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-2xl font-semibold text-slate-950">我接下的任务</h2>
          <div className="grid gap-4">
            {acceptedErrands.length === 0 ? (
              <div className="rounded-[24px] border border-slate-200 bg-white p-6 text-sm text-slate-500">
                你还没有接单任务。
              </div>
            ) : (
              acceptedErrands.map((errand) => (
                <article
                  key={errand.id}
                  className="rounded-[24px] border border-slate-200 bg-white p-5"
                >
                  <div className="flex items-center justify-between gap-3 text-sm text-slate-500">
                    <span>{ERRAND_STATUS_LABELS[errand.status]}</span>
                    <span>{errand.publisher.name}</span>
                  </div>
                  <h3 className="mt-2 text-lg font-semibold text-slate-950">{errand.title}</h3>
                  <p className="mt-2 text-sm text-slate-600">
                    {errand.pickupLocation} -&gt; {errand.deliveryLocation}
                  </p>
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <span className="text-lg font-semibold text-slate-950">
                      ¥{errand.reward.toString()}
                    </span>
                    <Link
                      href={`/errands/${errand.id}`}
                      className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                    >
                      查看详情
                    </Link>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
