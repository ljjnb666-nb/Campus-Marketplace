import { Heart } from "lucide-react";
import { toggleFavorite } from "@/actions/product";
import { cn } from "@/lib/utils";

export function FavoriteButton({
  productId,
  isFavorited,
  count,
}: {
  productId: string;
  isFavorited: boolean;
  count: number;
}) {
  return (
    <form action={toggleFavorite}>
      <input type="hidden" name="productId" value={productId} />
      <button
        type="submit"
        className={cn(
          "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition",
          isFavorited
            ? "border-rose-200 bg-rose-50 text-rose-700"
            : "border-slate-200 text-slate-700 hover:border-slate-300 hover:text-slate-950",
        )}
      >
        <Heart className={cn("size-4", isFavorited && "fill-current")} />
        {isFavorited ? "已收藏" : "收藏"}
        <span className="text-xs">{count}</span>
      </button>
    </form>
  );
}
