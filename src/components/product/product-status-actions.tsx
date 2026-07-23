import { updateProductStatus } from "@/actions/product";
import { PRODUCT_STATUS_LABELS } from "@/constants/product";

const statusOptions = [
  { value: "ACTIVE", label: "重新上架" },
  { value: "RESERVED", label: "标记预订" },
  { value: "SOLD", label: "标记售出" },
  { value: "OFFLINE", label: "下架" },
] as const;

export function ProductStatusActions({
  productId,
  currentStatus,
}: {
  productId: string;
  currentStatus: keyof typeof PRODUCT_STATUS_LABELS;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {statusOptions
        .filter((option) => option.value !== currentStatus)
        .map((option) => (
          <form key={option.value} action={updateProductStatus}>
            <input type="hidden" name="productId" value={productId} />
            <input type="hidden" name="status" value={option.value} />
            <button
              type="submit"
              className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
            >
              {option.label}
            </button>
          </form>
        ))}
    </div>
  );
}
