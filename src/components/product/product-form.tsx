"use client";

import React, { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { PriceDisplay } from "@/components/ui/price-display";
import { ImageUploader, UploadedImage } from "@/components/shared/image-uploader";
import { PRODUCT_CONDITION_LABELS } from "@/constants/product";

type ActionState = {
  error?: string;
  message: string;
  success: boolean;
  redirectTo?: string;
};

interface ProductFormProps {
  categories: { id: string; name: string }[];
  currentCampusName?: string;
  defaultValues?: {
    title?: string;
    description?: string;
    price?: number | string;
    originalPrice?: number | string;
    categoryId?: string;
    condition?: string;
    locationText?: string;
    images?: { url: string }[];
  };
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  productId?: string;
  submitLabel?: string;
}

export function ProductForm({
  categories,
  currentCampusName = "主校区",
  defaultValues,
  action,
  productId,
  submitLabel = "发布商品",
}: ProductFormProps) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(action, { success: false, message: "" });
  const [price, setPrice] = useState(defaultValues?.price?.toString() || "");
  const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>(
    defaultValues?.images?.map((img) => ({ url: img.url, preview: img.url })) || []
  );

  React.useEffect(() => {
    if (state.success && state.redirectTo) {
      router.push(state.redirectTo);
      router.refresh();
    }
  }, [state, router]);

  const errorMessage = state.error || state.message;

  return (
    <form action={formAction} className="space-y-6">
      {productId && <input type="hidden" name="productId" value={productId} />}

      {errorMessage && (
        <div className="rounded-2xl bg-rose-50 p-4 text-xs font-semibold text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          {errorMessage}
        </div>
      )}

      {/* 标题 */}
      <div className="space-y-1.5">
        <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
          商品标题 <span className="text-rose-500">*</span>
        </label>
        <input
          type="text"
          name="title"
          required
          defaultValue={defaultValues?.title}
          placeholder="品牌品名、型号规格、关键特色（例：九成新 罗技 G304 无线鼠标）"
          className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-900 outline-none transition focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
        />
      </div>

      {/* 分类与新旧成色 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
            商品分类 <span className="text-rose-500">*</span>
          </label>
          <select
            name="categoryId"
            required
            defaultValue={defaultValues?.categoryId}
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-900 outline-none transition focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
          >
            <option value="">请选择所属分类</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
            成色等级 <span className="text-rose-500">*</span>
          </label>
          <select
            name="condition"
            required
            defaultValue={defaultValues?.condition || "LIKE_NEW"}
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-900 outline-none transition focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
          >
            {Object.entries(PRODUCT_CONDITION_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 价格与原价 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
            转让价格 (元) <span className="text-rose-500">*</span>
          </label>
          <div className="relative">
            <span className="absolute left-4 top-3 text-xs text-slate-400 font-bold">¥</span>
            <input
              type="number"
              step="0.01"
              name="price"
              required
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-2xl border border-slate-200 bg-white pl-8 pr-4 py-3 text-xs text-slate-900 outline-none transition focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>
          {price && <PriceDisplay price={price} size="sm" />}
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
            入手原价/参考价 (元，选填)
          </label>
          <div className="relative">
            <span className="absolute left-4 top-3 text-xs text-slate-400 font-bold">¥</span>
            <input
              type="number"
              step="0.01"
              name="originalPrice"
              defaultValue={defaultValues?.originalPrice?.toString()}
              placeholder="0.00"
              className="w-full rounded-2xl border border-slate-200 bg-white pl-8 pr-4 py-3 text-xs text-slate-900 outline-none transition focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>
        </div>
      </div>

      {/* 交易地点与校区 */}
      <div className="space-y-1.5">
        <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
          当面交易地点 ({currentCampusName}) <span className="text-rose-500">*</span>
        </label>
        <input
          type="text"
          name="locationText"
          required
          defaultValue={defaultValues?.locationText}
          placeholder="详细面交接头位置（例：图书馆主楼门口 / 3号宿舍楼下）"
          className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-900 outline-none transition focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
        />
      </div>

      {/* 描述详情 */}
      <div className="space-y-1.5">
        <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
          详细描述说明 <span className="text-rose-500">*</span>
        </label>
        <textarea
          name="description"
          rows={5}
          required
          defaultValue={defaultValues?.description}
          placeholder="说明商品购买渠道、使用磨损情况、有无原盒发票、是否接受小刀等..."
          className="w-full rounded-2xl border border-slate-200 bg-white p-4 text-xs text-slate-900 outline-none transition focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
        />
      </div>

      {/* 实物图片 */}
      <div className="space-y-1.5">
        <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
          实物展示图片 (最多9张)
        </label>
        <ImageUploader
          category="product"
          images={uploadedImages}
          onChange={setUploadedImages}
          maxCount={9}
        />
        {uploadedImages.map((img, i) => (
          <input key={i} type="hidden" name="imageUrls" value={img.url || img.preview} />
        ))}
      </div>

      {/* 提交按钮 */}
      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 py-3.5 text-sm font-bold text-white shadow-lg shadow-indigo-500/25 transition hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-50"
      >
        {isPending ? "处理中..." : submitLabel}
      </button>
    </form>
  );
}
