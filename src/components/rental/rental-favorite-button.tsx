import { Heart } from "lucide-react";
import Link from "next/link";
import { toggleRentalFavorite } from "@/actions/rental-favorite";
import { cn } from "@/lib/utils";

interface RentalFavoriteButtonProps {
  rentalListingId: string;
  isFavorited: boolean;
  count: number;
  /** 未登录时传 false，按钮点击跳转登录 */
  isLoggedIn?: boolean;
}

export function RentalFavoriteButton({
  rentalListingId,
  isFavorited,
  count,
  isLoggedIn = true,
}: RentalFavoriteButtonProps) {
  if (!isLoggedIn) {
    return (
      <Link
        href="/login"
        className={cn(
          "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition",
          "border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700",
        )}
      >
        <Heart className="size-4" />
        收藏
        <span className="text-xs text-slate-400">{count}</span>
      </Link>
    );
  }

  return (
    <form action={toggleRentalFavorite}>
      <input type="hidden" name="rentalListingId" value={rentalListingId} />
      <button
        type="submit"
        className={cn(
          "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition",
          isFavorited
            ? "border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100"
            : "border-slate-200 text-slate-600 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600",
        )}
      >
        <Heart
          className={cn(
            "size-4 transition-all",
            isFavorited && "fill-current",
          )}
        />
        {isFavorited ? "已收藏" : "收藏"}
        <span className="text-xs">{count}</span>
      </button>
    </form>
  );
}
