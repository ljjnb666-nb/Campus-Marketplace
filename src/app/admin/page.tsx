import { redirect } from "next/navigation";

/**
 * Phase 7H：legacy /admin root dashboard 退役 → canonical /governance redirect。
 *
 * 硬合同（Planning §40/§61 冻结）：
 * - canonical dashboard truth = /governance；legacy /admin root 仅剩
 *   redirect，不再构成 active operational truth；
 * - 不保留两套 dashboard authority：getAdminDashboardData() 及其唯一消费
 *   页面一并退休（其余 legacy maintenance 子页 categories/keywords/products/
 *   errands/services 不在本 slice 范围，保持原状）；
 * - 不在本页做 requireAdmin 预检：重定向本身不泄露数据，未授权访问者随后
 *   由 /governance layout root gate（notFound）承接；
 * - legacy requireAdmin 桥零修改（7D R1 冻结）。
 */
export const dynamic = "force-dynamic";

export default function AdminPage() {
  redirect("/governance");
}
