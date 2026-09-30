/**
 * Phase 8B-01：PRODUCT PENDING reservation deadline 的中央时间原语。
 *
 * PRODUCT 预留 = system-owned Order lifecycle 投影（Phase 8A-02 冻结）：
 * buyer 创建 PRODUCT Order → Product RESERVED + seller 确认截止
 *（reservationExpiresAt = 事务捕获的 now + 24h TTL）。deadline 是 seller
 * confirmation deadline，不是整个订单生命周期 deadline——期限内 ACCEPT 后
 * timeout 被转化为正式交易义务，不再继续过期。
 *
 * 时间边界冻结：now >= expiresAt 即已过期（exact deadline instant =
 * EXPIRED）；accept / cancel / explicit expire 全部经
 * isProductReservationExpired 判定，禁止各路径自行漂移 `>` / `>=`。
 *
 * 24h 常量只在此定义一次（Phase 10 前不引入 Config Center）。
 */

/** PRODUCT 预留 TTL（冻结默认 24 HOURS）。 */
export const PRODUCT_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

/** 由事务捕获的单一 now 计算 seller 确认截止（同事务内禁止多次取钟漂移）。 */
export function computeProductReservationExpiresAt(now: Date): Date {
  return new Date(now.getTime() + PRODUCT_RESERVATION_TTL_MS);
}

/**
 * 预留是否已过期（冻结边界：now >= expiresAt → expired）。
 * accept / cancel / expire 的唯一时间判定来源。
 */
export function isProductReservationExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

/**
 * expiry winner 的 Order.cancelReason：system copy，禁止携带任何
 * user-authored 内容（Product title / note / meetingLocation）。
 */
export const PRODUCT_RESERVATION_EXPIRED_CANCEL_REASON = "商品预留超时自动释放";
