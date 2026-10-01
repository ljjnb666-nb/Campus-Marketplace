import type { RentalOrderStatus } from "@prisma/client";

/**
 * RB02：RentalDispute 可发起状态——domain SSOT 的 client-safe 投影源。
 *
 * 唯一定义在本文件；rental-order-machine.ts 从本模块 re-export
 * isDisputableStatus（domain authority 与 UI projection 同源，禁止第二份
 * 状态黑名单）。本模块只依赖 Prisma 类型，可被 Client Component 安全导入。
 *
 * 合同冻结：COMPLETED ∈ disputable——提交评价 ≠ 放弃发起纠纷权利
 * （Phase 8A-04/8E 冻结语义）；review 存在永远不是 dispute eligibility。
 */
const DISPUTABLE_STATUSES: readonly RentalOrderStatus[] = [
  "IN_RENTAL",
  "PENDING_RETURN",
  "PENDING_INSPECTION",
  "COMPLETED",
  "PICKED_UP",
];

export function isDisputableStatus(status: RentalOrderStatus): boolean {
  return DISPUTABLE_STATUSES.includes(status);
}
