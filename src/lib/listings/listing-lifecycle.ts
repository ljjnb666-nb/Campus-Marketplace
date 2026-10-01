/**
 * Phase 8F（LISTING LIFECYCLE NORMALIZATION）——四类 listing 的 Lifecycle
 * Contract SSOT（client/server-safe 纯策略模块，零 Prisma / 零服务端依赖）。
 *
 * 冻结边界：本模块统一的是 Lifecycle Contract，不是 Storage Model——
 * Product / ServiceListing / ErrandTask / RentalListing 四个 domain 保持
 * 独立存储，绝不合并为通用 Listing 表。Errand 的 workflow 状态机权威仍是
 * src/lib/errand-lifecycle.ts；Product 预留投影权威仍是
 * src/lib/product-order-lifecycle.ts；Rental 订单状态机权威仍是
 * src/lib/rental-order-machine.ts。本模块只拥有：
 *   1. PUBLIC EXPOSURE（公开市场发现语义）的唯一口径
 *   2. 各 domain 可持久化 canonical 状态集合 + legacy 保留值
 *   3. 用户可请求的 status mutation 目标运行时白名单
 *   4. active obligation 状态集合（Service/Rental central helper）
 *   5. wind-down 中文文案（§45 详情不可用提示）
 *
 * 语义冻结：
 *   PUBLIC_EXPOSED = 陌生用户 / 匿名用户可以在 marketplace discovery
 *   surface 发现。因此 Product ACTIVE / Service ACTIVE / Errand OPEN /
 *   Rental AVAILABLE 是唯一的公开曝光状态；wind-down（RESERVED/SOLD/
 *   OFFLINE/PAUSED/非 OPEN workflow 态）一律不得进入公开发现面。
 */

// ── §9 Public Exposure SSOT ─────────────────────────────────────────────

export const PRODUCT_PUBLIC_EXPOSURE_STATUS = "ACTIVE" as const;
export const SERVICE_PUBLIC_EXPOSURE_STATUS = "ACTIVE" as const;
export const ERRAND_PUBLIC_EXPOSURE_STATUS = "OPEN" as const;
export const RENTAL_PUBLIC_EXPOSURE_STATUS = "AVAILABLE" as const;

// ── Canonical 可持久化状态集合（DB CHECK 同源口径）────────────────────

export type ProductLifecycleStatus = "ACTIVE" | "RESERVED" | "SOLD" | "OFFLINE";
export type ServiceLifecycleStatus = "ACTIVE" | "PAUSED" | "OFFLINE";
export type RentalLifecycleStatus = "AVAILABLE" | "PAUSED" | "OFFLINE";

export const PRODUCT_ALLOWED_STATUSES: readonly ProductLifecycleStatus[] = [
  "ACTIVE",
  "RESERVED",
  "SOLD",
  "OFFLINE",
];

export const SERVICE_ALLOWED_STATUSES: readonly ServiceLifecycleStatus[] = [
  "ACTIVE",
  "PAUSED",
  "OFFLINE",
];

export const RENTAL_ALLOWED_STATUSES: readonly RentalLifecycleStatus[] = [
  "AVAILABLE",
  "PAUSED",
  "OFFLINE",
];

/**
 * Rental legacy enum 保留值：仅存于 Prisma/PostgreSQL enum（不做 enum 删除），
 * 生产写路径 NEVER WRITE，运行时 fail closed。FULLY_BOOKED 不是 canonical
 * availability authority（可租库存权威 = RentalListing FOR UPDATE +
 * RentalUnavailablePeriod + checkTimeConflict + totalQuantity）。
 * RentalListing.availableQuantity 为 NON_AUTHORITATIVE_LEGACY_FIELD——
 * 禁止作为 booking authority 消费。
 */
export const RENTAL_LEGACY_STATUSES: readonly string[] = [
  "FULLY_BOOKED",
  "PENDING_REVIEW",
  "BANNED",
];

// ── Public exposure 判定（统一读口径；禁止各 repository 手写 status 谓词）──

export function isProductPubliclyExposed(status: string): boolean {
  return status === PRODUCT_PUBLIC_EXPOSURE_STATUS;
}

export function isServicePubliclyExposed(status: string): boolean {
  return status === SERVICE_PUBLIC_EXPOSURE_STATUS;
}

export function isErrandPubliclyExposed(status: string): boolean {
  return status === ERRAND_PUBLIC_EXPOSURE_STATUS;
}

export function isRentalPubliclyExposed(status: string): boolean {
  return status === RENTAL_PUBLIC_EXPOSURE_STATUS;
}

// ── §26 运行时目标白名单（TypeScript 类型不是安全边界；防 as never 绕过）──

export const SELLER_PRODUCT_STATUS_TARGETS: ReadonlySet<string> = new Set([
  "ACTIVE",
  "OFFLINE",
]);

export const SERVICE_STATUS_TARGETS: ReadonlySet<string> = new Set([
  "ACTIVE",
  "PAUSED",
  "OFFLINE",
]);

export const RENTAL_STATUS_TARGETS: ReadonlySet<string> = new Set([
  "AVAILABLE",
  "PAUSED",
  "OFFLINE",
]);

// ── Active obligation central helpers（delete/新义务判定共用，禁止复制）──

/**
 * Service Order 的 active obligation 状态（存在即禁止删除 listing）。
 * PENDING / ACCEPTED / IN_PROGRESS / IN_DISPUTE（Phase 8C：dispute 治理
 * 冻结仍属 active obligation）；COMPLETED / CANCELLED / CLOSED 是 terminal。
 */
export const ACTIVE_SERVICE_ORDER_STATUSES: readonly [
  "PENDING",
  "ACCEPTED",
  "IN_PROGRESS",
  "IN_DISPUTE",
] = ["PENDING", "ACCEPTED", "IN_PROGRESS", "IN_DISPUTE"];

/**
 * Rental Order 的 terminal 状态（§32）：COMPLETED / CANCELLED / REJECTED /
 * CLOSED 不算 active obligation；其余状态（含 IN_DISPUTE / OVERDUE /
 * PENDING_* / IN_RENTAL / PICKED_UP）均为 active。删除判定用
 * `status NOT IN terminal` 表达，与既有 deleteRentalListing 语义同源。
 */
export const RENTAL_TERMINAL_ORDER_STATUSES: readonly [
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
  "CLOSED",
] = ["COMPLETED", "CANCELLED", "REJECTED", "CLOSED"];

// ── §45 Wind-down 详情提示（owner / 履约参与方可见的中文状态说明）────────

export const PRODUCT_WIND_DOWN_MESSAGES: Record<ProductLifecycleStatus, string> = {
  ACTIVE: "",
  RESERVED: "该商品已进入预订流程，交易进行中",
  SOLD: "该商品已售出，交易已完成",
  OFFLINE: "该商品当前不再公开出售",
};

export const SERVICE_WIND_DOWN_MESSAGES: Record<ServiceLifecycleStatus, string> = {
  ACTIVE: "",
  PAUSED: "该服务当前暂停接单",
  OFFLINE: "该服务当前不再公开出售",
};

export const RENTAL_WIND_DOWN_MESSAGES: Record<RentalLifecycleStatus, string> = {
  AVAILABLE: "",
  PAUSED: "该租赁物品当前暂停出租",
  OFFLINE: "该租赁物品当前不再公开出租",
};

export const ERRAND_WIND_DOWN_MESSAGES: Record<string, string> = {
  OPEN: "",
  CLAIMED: "该跑腿任务已被接单，进入履约流程",
  IN_PROGRESS: "该跑腿任务正在进行中",
  PENDING_CONFIRMATION: "该跑腿任务已完成，等待确认",
  COMPLETED: "该跑腿任务已完成",
  CANCELLED: "该跑腿任务已取消",
  DISPUTED: "该跑腿任务正在纠纷处理中",
  CLOSED: "该跑腿任务已关闭",
};
