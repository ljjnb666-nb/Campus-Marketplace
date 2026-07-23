import { updateService } from "@/actions/service";
import { ServiceForm } from "@/components/service/service-form";
import { requireUser } from "@/lib/server-auth";
import { getServiceForEdit } from "@/repositories/service-repository";

export const dynamic = "force-dynamic";

export default async function EditServicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { service, categories } = await getServiceForEdit(id, user.id);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <div className="mb-8 space-y-2">
        <h1 className="text-3xl font-semibold text-slate-950">编辑服务</h1>
        <p className="text-sm text-slate-600">调整服务分类、定价、时间安排和展示信息。</p>
      </div>

      <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <ServiceForm
          action={updateService}
          categories={categories}
          submitLabel="保存修改"
          initialValues={{
            serviceId: service.id,
            title: service.title,
            description: service.description,
            categoryId: service.categoryId,
            price: service.price.toString(),
            pricingUnit: service.pricingUnit,
            locationText: service.locationText,
            availableSchedule: service.availableSchedule ?? "",
            coverImageUrl: service.coverImageUrl,
          }}
        />
      </div>
    </div>
  );
}
