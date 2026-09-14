import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

/**
 * Phase 7C legacy 委托：服务治理能力已完整迁移至 /governance/listings
 * （列表检视 ⊂ 治理队列浏览 tab，强制下架 → canonical moderation service，
 * 另获 restore/治理历史/举报只读 badge 能力）。PLATFORM_ADMIN 经 requireAdmin
 * 兼容桥保留 legacy 入口，落点即治理面。raw moderation 写入口已删除
 * （普查不变量：零第二写 authority）。
 */
export default async function AdminServicesPage() {
  await requireAdmin();
  redirect("/governance/listings");
}
