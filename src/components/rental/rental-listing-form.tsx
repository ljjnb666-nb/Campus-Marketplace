"use client";

import React, { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { ImageUploader, type UploadedImage } from "@/components/shared/image-uploader";

type Category = {
  id: string;
  name: string;
};

type RentalListingDefaultValues = {
  title?: string;
  categoryId?: string;
  condition?: string;
  brand?: string | null;
  model?: string | null;
  referenceValue?: number;
  totalQuantity?: number;
  price?: number;
  pricingUnit?: string;
  depositAmount?: number;
  minimumDuration?: number;
  maximumDuration?: number;
  pickupLocation?: string;
  returnLocation?: string;
  description?: string;
  usageRules?: string | null;
  damagePolicy?: string | null;
  overduePolicy?: string | null;
  requiresApproval?: boolean;
  images?: string[];
};

type RentalListingActionState = {
  success: boolean;
  message: string;
  redirectTo?: string;
};


type RentalListingFormProps = {
  categories: Category[];
  currentCampusName: string;
  defaultValues?: RentalListingDefaultValues;
  action: (state: RentalListingActionState | null, payload: FormData) => Promise<RentalListingActionState>;
  listingId?: string;
};

export function RentalListingForm({
  categories,
  currentCampusName,
  defaultValues,
  action,
  listingId,
}: RentalListingFormProps) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(action, null);
  const [images, setImages] = useState<UploadedImage[]>(
    defaultValues?.images?.map((url) => ({ url, preview: url })) || []
  );
  const [coverIndex, setCoverIndex] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  if (state?.success && !uploading) {
    if (listingId) {
      router.push(`/rentals/${listingId}`);
    } else {
      router.push(`/my/rental-listings`);
    }
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setUploading(true);

    try {
      const formData = new FormData(e.currentTarget);

      // ImageUploader 选图后已即时上传，url 即服务端 token；兜底处理遗留 file
      const uploadedUrls: string[] = [];
      for (const image of images) {
        if (image.url) {
          uploadedUrls.push(image.url);
        } else if (image.file) {
          const uploadFormData = new FormData();
          uploadFormData.append("file", image.file);
          uploadFormData.append("category", "rental");

          const response = await fetch("/api/upload/images", {
            method: "POST",
            body: uploadFormData,
          });

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || "上传失败");
          }

          const result = await response.json();
          uploadedUrls.push(result.url ?? `asset:${result.assetId}`);
        }
      }

      // 服务端 action 读取的字段名是 imageUrls（历史版本误用 images[] 导致图片被丢弃）
      formData.delete("images[]");
      uploadedUrls.forEach((url) => {
        formData.append("imageUrls", url);
      });

      await formAction(formData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
      setUploading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-md md:p-10">
      {listingId && <input type="hidden" name="id" value={listingId} />}

      <div className="space-y-6">
        <h2 className="text-xl font-bold text-slate-900">基本信息</h2>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium text-slate-700">
              标题 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              name="title"
              required
              defaultValue={defaultValues?.title}
              placeholder="请输入租赁物品标题（如：大疆无人机 Mini 3 Pro，带三电）"
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">
              分类 <span className="text-red-500">*</span>
            </label>
            <select
              name="categoryId"
              required
              defaultValue={defaultValues?.categoryId}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="">请选择分类</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">
              成色 <span className="text-red-500">*</span>
            </label>
            <select
              name="condition"
              required
              defaultValue={defaultValues?.condition}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="">请选择成色</option>
              <option value="BRAND_NEW">全新</option>
              <option value="LIKE_NEW">99新</option>
              <option value="EXCELLENT">95新</option>
              <option value="GOOD">9成新</option>
              <option value="FAIR">8成新及以下</option>
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">品牌（选填）</label>
            <input
              type="text"
              name="brand"
              defaultValue={defaultValues?.brand ?? ""}
              placeholder="例如：大疆"
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">型号（选填）</label>
            <input
              type="text"
              name="model"
              defaultValue={defaultValues?.model ?? ""}
              placeholder="例如：Mini 3 Pro"
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">物品原价参考（选填）</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">¥</span>
              <input
                type="number"
                step="0.01"
                min="0"
                name="referenceValue"
                defaultValue={defaultValues?.referenceValue}
                placeholder="0.00"
                className="w-full rounded-2xl border border-slate-200 bg-white py-2.5 pl-8 pr-4 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">库存数量</label>
            <input
              type="number"
              min="1"
              name="totalQuantity"
              defaultValue={defaultValues?.totalQuantity || 1}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </div>
        </div>
      </div>

      <hr className="border-slate-100" />

      <div className="space-y-6">
        <h2 className="text-xl font-bold text-slate-900">价格与租期</h2>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">
              租金设置 <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">¥</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  name="price"
                  required
                  defaultValue={defaultValues?.price}
                  placeholder="0.00"
                  className="w-full rounded-2xl border border-slate-200 bg-white py-2.5 pl-8 pr-4 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
              </div>
              <select
                name="pricingUnit"
                required
                defaultValue={defaultValues?.pricingUnit || "PER_DAY"}
                className="w-32 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              >
                <option value="PER_HOUR">/小时</option>
                <option value="PER_DAY">/天</option>
                <option value="PER_WEEK">/周</option>
                <option value="PER_MONTH">/月</option>
                <option value="PER_SESSION">/次</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">
              押金 <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">¥</span>
              <input
                type="number"
                step="0.01"
                min="0"
                name="depositAmount"
                required
                defaultValue={defaultValues?.depositAmount}
                placeholder="填写0即为免押金"
                className="w-full rounded-2xl border border-slate-200 bg-white py-2.5 pl-8 pr-4 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <p className="text-xs text-slate-500">填 0 即为免押金</p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">最短租期（选填）</label>
            <input
              type="number"
              min="1"
              name="minimumDuration"
              defaultValue={defaultValues?.minimumDuration}
              placeholder="例如：1"
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">最长租期（选填）</label>
            <input
              type="number"
              min="1"
              name="maximumDuration"
              defaultValue={defaultValues?.maximumDuration}
              placeholder="留空表示不限制"
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </div>
        </div>
      </div>

      <hr className="border-slate-100" />

      <div className="space-y-6">
        <h2 className="text-xl font-bold text-slate-900">交接与详情</h2>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">
              取货地点 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              name="pickupLocation"
              required
              defaultValue={defaultValues?.pickupLocation || currentCampusName}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">
              归还地点 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              name="returnLocation"
              required
              defaultValue={defaultValues?.returnLocation || currentCampusName}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium text-slate-700">
              物品描述 <span className="text-red-500">*</span>
            </label>
            <textarea
              name="description"
              required
              rows={4}
              defaultValue={defaultValues?.description}
              placeholder="详细描述物品的规格、配件及当前状态等..."
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium text-slate-700">使用规则（选填）</label>
            <textarea
              name="usageRules"
              rows={2}
              defaultValue={defaultValues?.usageRules ?? ""}
              placeholder="例如：不可下水、需自备存储卡..."
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">损坏赔偿说明（选填）</label>
            <textarea
              name="damagePolicy"
              rows={2}
              defaultValue={defaultValues?.damagePolicy ?? ""}
              placeholder="例如：炸机需按原价70%赔偿..."
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">逾期政策（选填）</label>
            <textarea
              name="overduePolicy"
              rows={2}
              defaultValue={defaultValues?.overduePolicy ?? ""}
              placeholder="例如：逾期超过一天扣除押金50%..."
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="requiresApproval"
            name="requiresApproval"
            value="true"
            defaultChecked={defaultValues?.requiresApproval ?? true}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          <label htmlFor="requiresApproval" className="text-sm text-slate-700">
            租用请求需要我手动确认（取消勾选则为自动确认）
          </label>
        </div>
      </div>

      <hr className="border-slate-100" />

      <div className="space-y-4">
        <h2 className="text-xl font-bold text-slate-900">图片上传</h2>
        <ImageUploader
          images={images}
          onChange={setImages}
          category="rental"
          coverIndex={coverIndex}
          onCoverChange={setCoverIndex}
        />
      </div>

      {(state?.message && !state?.success) || error ? (
        <div className="rounded-2xl bg-red-50 p-4 text-sm text-red-600">
          {state?.message || error}
        </div>
      ) : null}

      <div className="pt-4">
        <button
          type="submit"
          disabled={isPending || uploading}
          className="w-full rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-500/30 transition hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-70"
        >
          {(isPending || uploading) ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : (listingId ? "保存修改" : "发布租赁")}
        </button>
      </div>
    </form>
  );
}
