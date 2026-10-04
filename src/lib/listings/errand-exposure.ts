import type { Prisma } from "@prisma/client";

import { listingModerationPublicFilter } from "@/lib/moderation/listing-moderation-query";
import { ERRAND_PUBLIC_EXPOSURE_STATUS } from "@/lib/listings/listing-lifecycle";

/**
 * Phase 9C-02（§6/§7）：Errand 公开曝光的唯一 server 查询口径（SSOT）。
 *
 *   PUBLIC_EXPOSED = deletedAt IS NULL AND status = OPEN
 *                    AND deadline > now AND moderation allows
 *
 * 与 client-safe 纯谓词 isErrandPubliclyExposed（listing-lifecycle.ts）
 * 共同构成 Errand public exposure contract：一切公开 discovery / 投影
 * 查询（列表、首页、搜索、推荐池、收藏投影、sitemap、收藏资格判定）
 * 必须经由本 helper，禁止各查询手写 `status: "OPEN"` 漏掉 deadline
 * 下界（Phase 9C-02 关闭的缺口：过期 OPEN 任务在 worker materialize
 * 前仍可进入公开发现面）。
 *
 * now 合同：调用方在同一 request/query 内捕获一次传入；同一次分页查询
 * 的 items 与 count 必须共用同一个 now（deadline 跨界时保证
 * items/total 一致）。公开 TTL 缓存（cachedPublicRead）的既有 SLA
 * （stale ≤ 30s）不受本合同改变。
 */
/** canonical exposure where 的精确形状（deadline 必须保持 `{ gt }` 对象——
 * 调用方（如用户筛选窗口合并）需要可展开的对象类型，而非 Prisma 联合）。 */
export type ErrandPublicExposureWhere = {
  deletedAt: null;
  status: typeof ERRAND_PUBLIC_EXPOSURE_STATUS;
  deadline: { gt: Date };
  moderations: { none: { resolvedAt: null } };
};

export function errandPublicExposureFilter(now: Date): ErrandPublicExposureWhere {
  return {
    deletedAt: null,
    status: ERRAND_PUBLIC_EXPOSURE_STATUS,
    deadline: { gt: now },
    ...listingModerationPublicFilter(),
  };
}
