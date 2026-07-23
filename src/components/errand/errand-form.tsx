"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import type { ErrandActionState } from "@/actions/errand";

type ErrandCategoryOption = {
  id: string;
  name: string;
};

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending} className="rounded-full px-5">
      {pending ? "提交中..." : label}
    </Button>
  );
}

type ErrandValues = {
  errandId?: string;
  title?: string;
  description?: string;
  categoryId?: string;
  reward?: string;
  pickupLocation?: string;
  deliveryLocation?: string;
  deadline?: string;
  contactNote?: string;
  needsAdvancePay?: boolean;
  advanceAmount?: string;
};

export function ErrandForm({
  action,
  categories,
  initialValues,
  submitLabel,
}: {
  action: (
    state: ErrandActionState,
    formData: FormData,
  ) => Promise<ErrandActionState>;
  categories: ErrandCategoryOption[];
  initialValues?: ErrandValues;
  submitLabel: string;
}) {
  const router = useRouter();
  const [state, formAction] = useActionState(action, {
    success: false,
    message: "",
  });

  useEffect(() => {
    if (state.success && state.redirectTo) {
      router.push(state.redirectTo);
      router.refresh();
    }
  }, [router, state.redirectTo, state.success]);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {initialValues?.errandId ? (
        <input type="hidden" name="errandId" value={initialValues.errandId} />
      ) : null}

      <label className="flex flex-col gap-2 text-sm">
        任务标题
        <input
          name="title"
          defaultValue={initialValues?.title}
          required
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          placeholder="例如：帮我从快递站取快递"
        />
      </label>

      <label className="flex flex-col gap-2 text-sm">
        任务描述
        <textarea
          name="description"
          defaultValue={initialValues?.description}
          required
          rows={6}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          placeholder="补充件数、体积、注意事项等"
        />
      </label>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          任务分类
          <select
            name="categoryId"
            defaultValue={initialValues?.categoryId ?? ""}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          >
            <option value="">请选择任务分类</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-2 text-sm">
          报酬
          <input
            name="reward"
            type="number"
            min="0"
            step="0.01"
            defaultValue={initialValues?.reward}
            required
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          取件地点
          <input
            name="pickupLocation"
            defaultValue={initialValues?.pickupLocation}
            required
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
            placeholder="例如：东区快递站"
          />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          送达地点
          <input
            name="deliveryLocation"
            defaultValue={initialValues?.deliveryLocation}
            required
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
            placeholder="例如：3 号宿舍楼 402"
          />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          截止时间
          <input
            name="deadline"
            type="datetime-local"
            defaultValue={initialValues?.deadline}
            required
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          联系说明
          <input
            name="contactNote"
            defaultValue={initialValues?.contactNote}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
            placeholder="例如：到了给我发消息"
          />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          是否需要垫付
          <select
            name="needsAdvancePay"
            defaultValue={initialValues?.needsAdvancePay ? "true" : "false"}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          >
            <option value="false">不需要</option>
            <option value="true">需要</option>
          </select>
        </label>
        <label className="flex flex-col gap-2 text-sm">
          垫付金额
          <input
            name="advanceAmount"
            type="number"
            min="0"
            step="0.01"
            defaultValue={initialValues?.advanceAmount}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          />
        </label>
      </div>

      {state.message ? (
        <p className={state.success ? "text-sm text-emerald-600" : "text-sm text-rose-600"}>
          {state.message}
        </p>
      ) : null}

      <div className="flex items-center justify-end">
        <SubmitButton label={submitLabel} />
      </div>
    </form>
  );
}
