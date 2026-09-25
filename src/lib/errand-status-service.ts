/**
 * AUDIT2-RB02：errand 状态 transition 的唯一权威已收敛到
 * src/lib/errand-lifecycle.ts（canonical participant locks → ErrandTask
 * FOR UPDATE → active Order FOR UPDATE → 谓词 → 写入）。
 *
 * 本模块仅为既有调用方（tests/integration/repair3-active-account-mutations
 * 的 RB-03 race tests）保留稳定导入名 updateErrandStatusTx；实现只有这一份，
 * 不存在第二 transition authority。
 */
export { transitionErrandTx as updateErrandStatusTx, type ErrandLifecycleSeams } from "@/lib/errand-lifecycle";
