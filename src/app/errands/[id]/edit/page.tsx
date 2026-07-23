import { updateErrand } from "@/actions/errand";
import { ErrandForm } from "@/components/errand/errand-form";
import { requireUser } from "@/lib/server-auth";
import { getErrandForEdit, getErrandFormMeta } from "@/repositories/errand-repository";

export const dynamic = "force-dynamic";

function toInputDateTime(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");

  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export default async function EditErrandPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const [errand, meta] = await Promise.all([getErrandForEdit(id, user.id), getErrandFormMeta()]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">编辑跑腿任务</h1>
        <p className="mt-2 text-sm text-slate-600">仅允许编辑自己发布且尚未接单的任务。</p>
      </div>

      <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <ErrandForm
          action={updateErrand}
          categories={meta.categories}
          submitLabel="保存修改"
          initialValues={{
            errandId: errand.id,
            title: errand.title,
            description: errand.description,
            categoryId: errand.categoryId,
            reward: errand.reward.toString(),
            pickupLocation: errand.pickupLocation,
            deliveryLocation: errand.deliveryLocation,
            deadline: toInputDateTime(errand.deadline),
            contactNote: errand.contactNote ?? "",
            needsAdvancePay: errand.needsAdvancePay,
            advanceAmount: errand.advanceAmount?.toString() ?? "",
          }}
        />
      </div>
    </div>
  );
}
