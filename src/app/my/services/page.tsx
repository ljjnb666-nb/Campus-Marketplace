 
import Link from "next/link";
import { deleteService } from "@/actions/service";
import { ServiceStatusActions } from "@/components/service/service-status-actions";
import {
  SERVICE_PRICING_UNIT_LABELS,
  SERVICE_STATUS_LABELS,
} from "@/constants/service";
import { requireUser } from "@/lib/server-auth";
import { getMyServices } from "@/repositories/service-repository";

export const dynamic = "force-dynamic";

export default async function MyServicesPage() {
  const user = await requireUser();
  const services = await getMyServices(user.id);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-slate-950">我的服务</h1>
          <p className="mt-2 text-sm text-slate-600">
            统一管理你发布的技能服务，包括编辑、暂停接单和下架。
          </p>
        </div>
        <Link
          href="/services/new"
          className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          发布新服务
        </Link>
      </div>

      <div className="grid gap-4">
        {services.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            你还没有发布服务。
          </div>
        ) : (
          services.map((service) => (
            <article
              key={service.id}
              className="grid gap-4 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm lg:grid-cols-[180px_1fr_auto]"
            >
              <img
                src={
                  service.coverImageUrl ??
                  "https://images.unsplash.com/photo-1521791136064-7986c2920216?auto=format&fit=crop&w=1200&q=80"
                }
                alt={service.title}
                className="h-40 w-full rounded-2xl object-cover"
              />
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
                  <span>{service.category.name}</span>
                  <span>·</span>
                  <span>
                    {
                      SERVICE_STATUS_LABELS[
                        service.status as "ACTIVE" | "PAUSED" | "OFFLINE"
                      ]
                    }
                  </span>
                  <span>·</span>
                  <span>{service.campus.name}</span>
                </div>
                <h2 className="text-xl font-semibold text-slate-950">{service.title}</h2>
                <p className="line-clamp-2 text-sm text-slate-600">{service.description}</p>
                <div className="flex flex-wrap gap-5 pt-1 text-sm text-slate-500">
                  <span>
                    价格：¥{service.price.toString()} /{" "}
                    {SERVICE_PRICING_UNIT_LABELS[service.pricingUnit]}
                  </span>
                  <span>完成：{service.completedOrderCount} 单</span>
                  <span>评分：{service.averageRating.toFixed(1)}</span>
                </div>
                <div className="flex flex-wrap gap-3 pt-2">
                  <Link
                    href={`/services/${service.id}`}
                    className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                  >
                    查看详情
                  </Link>
                  <Link
                    href={`/services/${service.id}/edit`}
                    className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                  >
                    编辑
                  </Link>
                  <form action={deleteService}>
                    <input type="hidden" name="serviceId" value={service.id} />
                    <button
                      type="submit"
                      className="rounded-full border border-rose-200 px-4 py-2 text-sm font-medium text-rose-700 transition hover:border-rose-300 hover:text-rose-800"
                    >
                      删除
                    </button>
                  </form>
                </div>
              </div>
              <div className="flex flex-col gap-2 lg:items-end">
                <ServiceStatusActions
                  serviceId={service.id}
                  currentStatus={service.status as "ACTIVE" | "PAUSED" | "OFFLINE"}
                />
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
