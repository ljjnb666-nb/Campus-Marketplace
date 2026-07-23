"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import type { ServiceActionState } from "@/actions/service";
import { SERVICE_PRICING_UNIT_LABELS } from "@/constants/service";
import { Button } from "@/components/ui/button";
import { ImageUploader, type UploadedImage } from "@/components/shared/image-uploader";

type ServiceCategoryOption = {
  id: string;
  name: string;
  slug: string;
};

type ServiceFormValues = {
  serviceId?: string;
  title?: string;
  description?: string;
  categoryId?: string;
  price?: string;
  pricingUnit?: keyof typeof SERVICE_PRICING_UNIT_LABELS;
  locationText?: string;
  availableSchedule?: string;
  coverImageUrl?: string | null;
};

function SubmitButton({ uploading }: { uploading: boolean }) {
  const { pending } = useFormStatus();
  const isDisabled = pending || uploading;

  return (
    <Button type="submit" disabled={isDisabled} className="rounded-full px-5">
      {isDisabled ? "提交中..." : "发布服务"}
    </Button>
  );
}

export function ServiceForm({
  action,
  categories,
  initialValues,
}: {
  action: (
    state: ServiceActionState,
    formData: FormData,
  ) => Promise<ServiceActionState>;
  categories: ServiceCategoryOption[];
  initialValues?: ServiceFormValues;
  submitLabel: string;
}) {
  const router = useRouter();
  const [images, setImages] = useState<UploadedImage[]>(
    initialValues?.coverImageUrl
      ? [{ url: initialValues.coverImageUrl, preview: initialValues.coverImageUrl }]
      : []
  );
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setUploading(true);

    try {
      const formData = new FormData(e.currentTarget);

      if (images.length > 0) {
        const image = images[0];
        if (image.url) {
          formData.set("coverImageUrl", image.url);
        } else if (image.file) {
          const uploadFormData = new FormData();
          uploadFormData.append("file", image.file);
          uploadFormData.append("category", "service");

          const response = await fetch("/api/upload/images", {
            method: "POST",
            body: uploadFormData,
          });

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || "上传失败");
          }

          const result = await response.json();
          formData.set("coverImageUrl", result.url);
        }
      }

      const result = await action({ success: false, message: "" }, formData);

      if (result.success && result.redirectTo) {
        router.push(result.redirectTo);
        router.refresh();
      } else if (result.message) {
        setError(result.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
    } finally {
      setUploading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {initialValues?.serviceId ? (
        <input type="hidden" name="serviceId" value={initialValues.serviceId} />
      ) : null}

      <label className="flex flex-col gap-2 text-sm">
        服务标题
        <input
          name="title"
          defaultValue={initialValues?.title}
          required
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          placeholder="例如：校园约拍 / PPT 美化 / 电脑系统重装"
        />
      </label>

      <label className="flex flex-col gap-2 text-sm">
        服务描述
        <textarea
          name="description"
          defaultValue={initialValues?.description}
          required
          rows={7}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          placeholder="说明你的服务内容、交付方式、适合场景和注意事项。"
        />
      </label>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          服务分类
          <select
            name="categoryId"
            defaultValue={initialValues?.categoryId ?? ""}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
            required
          >
            <option value="">请选择服务分类</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-2 text-sm">
          参考价格
          <input
            name="price"
            type="number"
            min="0"
            step="0.01"
            defaultValue={initialValues?.price}
            required
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          计费方式
          <select
            name="pricingUnit"
            defaultValue={initialValues?.pricingUnit ?? "PER_SESSION"}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          >
            {Object.entries(SERVICE_PRICING_UNIT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-2 text-sm">
          服务地点
          <input
            name="locationText"
            defaultValue={initialValues?.locationText}
            required
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
            placeholder="例如：图书馆、宿舍楼下、线上远程"
          />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          可预约时间
          <textarea
            name="availableSchedule"
            defaultValue={initialValues?.availableSchedule ?? ""}
            rows={4}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
            placeholder="例如：工作日晚 7 点后可约，周末全天可接单。"
          />
        </label>

        <div className="flex flex-col gap-2 text-sm">
          <span>封面图</span>
          <ImageUploader
            images={images}
            onChange={setImages}
            category="service"
          />
        </div>
      </div>

      {error && (
        <p className="text-sm text-rose-600">{error}</p>
      )}

      <div className="flex items-center justify-end">
        <SubmitButton uploading={uploading} />
      </div>
    </form>
  );
}
