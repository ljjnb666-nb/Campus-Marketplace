import { createService } from "@/actions/service";
import { ServiceForm } from "@/components/service/service-form";
import { requireUser } from "@/lib/server-auth";
import { getServiceFormMeta } from "@/repositories/service-repository";

export const dynamic = "force-dynamic";

export default async function NewServicePage() {
  await requireUser();
  const { categories } = await getServiceFormMeta();

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <div className="mb-8 space-y-2">
        <h1 className="text-3xl font-semibold text-slate-950">发布服务</h1>
        <p className="text-sm text-slate-600">
          先把你能提供的服务信息发布出来，后续用户可以基于服务详情页发起预约和沟通。
        </p>
      </div>

      <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <ServiceForm action={createService} categories={categories} submitLabel="立即发布" />
      </div>
    </div>
  );
}
