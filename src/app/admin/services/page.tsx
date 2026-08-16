import Link from "next/link";
import { moderateListing } from "@/actions/admin";
import { SERVICE_PRICING_UNIT_LABELS, SERVICE_STATUS_LABELS } from "@/constants/service";
import { requireAdmin } from "@/lib/server-auth";
import { getAdminServiceList } from "@/repositories/admin-repository";

export const dynamic = "force-dynamic";

export default async function AdminServicesPage() {
  await requireAdmin();
  const services = await getAdminServiceList();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">服务管理</h1>
        <p className="mt-2 text-sm text-slate-600">查看服务发布情况，并对违规服务执行下架处理。</p>
      </div>

      <div className="grid gap-4">
        {services.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            暂无待管理服务。
          </div>
        ) : (
          services.map((service) => (
            <article key={service.id} className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
                <div className="space-y-3 text-sm text-slate-600">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-950">{service.title}</h2>
                    <p className="mt-1 line-clamp-2">{service.description}</p>
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs text-slate-500">
                    <span>服务者：{service.provider.name}</span>
                    <span>分类：{service.category.name}</span>
                    <span>状态：{SERVICE_STATUS_LABELS[service.status as "ACTIVE" | "PAUSED" | "OFFLINE"]}</span>
                    <span>
                      价格：￥{service.price.toString()} / {SERVICE_PRICING_UNIT_LABELS[service.pricingUnit]}
                    </span>
                  </div>
                  <Link href={`/services/${service.id}`} className="inline-block text-sm text-slate-700 underline">
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
                  <input type="hidden" name="targetType" value="SERVICE" />
                  <input type="hidden" name="targetId" value={service.id} />
                  <button
                    type="submit"
                    className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                  >
                    强制下架
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
