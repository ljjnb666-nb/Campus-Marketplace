import Link from "next/link";
import { moderateListing } from "@/actions/admin";
import { ERRAND_STATUS_LABELS } from "@/constants/errand";
import { requireAdmin } from "@/lib/server-auth";
import { getAdminErrandList } from "@/repositories/admin-repository";

export const dynamic = "force-dynamic";

export default async function AdminErrandsPage() {
  await requireAdmin();
  const errands = await getAdminErrandList();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">任务管理</h1>
        <p className="mt-2 text-sm text-slate-600">查看跑腿任务状态，必要时直接取消任务。</p>
      </div>

      <div className="grid gap-4">
        {errands.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            暂无待管理任务。
          </div>
        ) : (
          errands.map((errand) => (
            <article key={errand.id} className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
                <div className="space-y-3 text-sm text-slate-600">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-950">{errand.title}</h2>
                    <p className="mt-1 line-clamp-2">{errand.description}</p>
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs text-slate-500">
                    <span>分类：{errand.category.name}</span>
                    <span>发布人：{errand.publisher.name}</span>
                    <span>接单人：{errand.accepter?.name ?? "暂无"}</span>
                    <span>状态：{ERRAND_STATUS_LABELS[errand.status]}</span>
                    <span>赏金：￥{errand.reward.toString()}</span>
                  </div>
                  <Link href={`/errands/${errand.id}`} className="inline-block text-sm text-slate-700 underline">
                    查看详情
                  </Link>
                </div>
                <form
                  action={async (formData) => {
                    "use server";
                    await moderateListing(formData);
                  }}
                  className="flex items-center"
                >
                  <input type="hidden" name="targetType" value="ERRAND" />
                  <input type="hidden" name="targetId" value={errand.id} />
                  <button
                    type="submit"
                    className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                  >
                    取消任务
                  </button>
                </form>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
