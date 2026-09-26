/**
 * FINAL REPAIR A（LR-011）：公开共享读数据的进程内 TTL 缓存。
 *
 * Freshness contract（本模块的存在理由，见 docs/DATABASE.md 与
 * FINAL REPAIR A 报告）：
 * - 只允许缓存与请求者身份无关的公开共享数据：校区列表、公开榜单、
 *   公开计数、分类/校区元数据。任何入参含 userId/会话语义、或返回值
 *   随 viewer 变化的读，一律禁止接入本缓存（防 cross-user /
 *   auth-state / favorite-state 泄漏）。
 * - 缓存 key 只允许低基数维度（当前仅 campusId）——高基数参数
 *   （q/sort/filter/分页，如 /search、/products?q=）禁止作为 key，
 *   防止 cache-key 爆炸。
 * - 失效策略为 TTL eventual consistency：公开榜单/计数允许陈旧
 *   ≤ PUBLIC_LISTING_TTL_MS（30s），元数据 ≤ PUBLIC_META_TTL_MS（60s）。
 *   mutation（create/update/delete listing、favorite、订单完成、治理
 *   takedown）不主动失效，依赖 TTL 过期；这是记录在案的 SLA 取舍，
 *   不是遗漏。
 * - 不引入 Redis：单实例 compose 拓扑下进程内缓存即可，公开页面可用性
 *   不与 Redis 可用性绑定（LR-070 范围不变）。
 * - 内存有界：MAX_ENTRIES 满时整体清空（key 空间 = campusId 维度，
 *   正常远达不到上限）。
 */
type Entry = { expiresAt: number; value: unknown };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/** 公开榜单/计数的陈旧上限（SLA：stale ≤ 30s）。 */
export const PUBLIC_LISTING_TTL_MS = 30_000;

/** 校区/分类等公开元数据的陈旧上限（SLA：stale ≤ 60s）。 */
export const PUBLIC_META_TTL_MS = 60_000;

const MAX_ENTRIES = 128;

/**
 * 公开共享读的 TTL 缓存包装。并发未命中时合并为一次 load（in-flight
 * 去重）；load 失败不缓存，等待方与后续请求照常回源。
 */
export async function cachedPublicRead<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value as T;
  }
  const pending = inflight.get(key);
  if (pending) {
    return pending as Promise<T>;
  }
  const task = load()
    .then((value) => {
      if (store.size >= MAX_ENTRIES) {
        store.clear();
      }
      store.set(key, { expiresAt: Date.now() + ttlMs, value });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}

/** 测试专用：清空全部缓存条目与在途加载。 */
export function clearPublicReadCacheForTest(): void {
  store.clear();
  inflight.clear();
}
