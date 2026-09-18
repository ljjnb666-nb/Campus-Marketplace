import { redirect } from "next/navigation";

/**
 * Phase 7E：legacy /admin/reports 退役 → canonical /governance/reports redirect。
 *
 * 硬合同（规划冻结）：
 * - 全仓举报 review 只剩一个 mutation authority（canonical
 *   report-review-service，经 /governance/reports 治理面触达）——legacy 页面
 *   不再渲染队列、不再直接挂载任何 report mutation 表单；
 * - 不在本页做 requireAdmin 预检：重定向本身不泄露数据，未授权访问者随后
 *   由 /governance/reports 的自守门（requireReportReviewer → notFound）承接；
 * - legacy requireAdmin 桥零修改（7D R1 冻结）。
 */
export const dynamic = "force-dynamic";

export default function AdminReportsRedirectPage() {
  redirect("/governance/reports");
}
