import { updateProductStatus } from "@/actions/product";
import { PRODUCT_STATUS_LABELS } from "@/constants/product";

// Phase 8A-02（P8-B01）：RESERVED/SOLD 是 system-owned Order lifecycle
// projection，不是卖家可主动制造的状态——卖家只能控制 ACTIVE/OFFLINE。
// SOLD 为 seller-terminal：不渲染任何 lifecycle mutation 操作（再售走
// 新 listing），状态展示仍由别处的状态标签承担。
// Phase 8F（§42）：RESERVED + active order 时 ACTIVE/OFFLINE 服务端一律
// DENY（system-owned projection 不可手工覆盖）——UI 不渲染两个必然失败的
// 按钮；stale RESERVED 的恢复路径保留在 server authority（fresh 判定无
// active order 时 ACTIVE 仍放行），UI 不基于 stale snapshot 猜。
const statusOptions = [
  { value: "ACTIVE", label: "重新上架" },
  { value: "OFFLINE", label: "下架" },
] as const;

export function ProductStatusActions({
  productId,
  currentStatus,
}: {
  productId: string;
  currentStatus: keyof typeof PRODUCT_STATUS_LABELS;
}) {
  if (currentStatus === "SOLD" || currentStatus === "RESERVED") {
    return null;
  }

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
