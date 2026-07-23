import Link from "next/link";
import { createErrand } from "@/actions/errand";
import { ErrandForm } from "@/components/errand/errand-form";
import { requireUser } from "@/lib/server-auth";
import { getErrandFormMeta } from "@/repositories/errand-repository";

export const dynamic = "force-dynamic";

export default async function NewErrandPage() {
  await requireUser();
  const meta = await getErrandFormMeta();

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-slate-950">发布跑腿任务</h1>
          <p className="mt-2 text-sm text-slate-600">支持代取快递、代拿外卖、代打印等校园即时任务。</p>
        </div>
        <Link
          href="/my/errands"
          className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
        >
          我的任务
        </Link>
      </div>

      <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <ErrandForm action={createErrand} categories={meta.categories} submitLabel="发布任务" />
      </div>
    </div>
  );
}
