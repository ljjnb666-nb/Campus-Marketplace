import type { Prisma, PrivacyRequest, PrivacyRequestStatus } from "@prisma/client";

import { governanceError } from "@/lib/governance/domain-errors";
import { logger } from "@/lib/logger";
import { prisma, withTransaction } from "@/lib/prisma";
import { eraseAccount, type AccountErasureResult } from "@/lib/privacy/account-erasure";

/**
 * PrivacyRequest 状态机（显式 transition helper，禁止任意赋值跳状态）。
 *
 *   REQUESTED → IN_PROGRESS → COMPLETED
 *                            → BLOCKED（有 hold/active transaction，等待治理处理）
 *                            → REJECTED（执行失败/超限，带 reasonCode）
 *   REQUESTED → CANCELLED（用户主动取消，尚未开始执行）
 *   BLOCKED → IN_PROGRESS（hold 解除后重试）| REJECTED（治理最终拒绝）
 *
 * 合法迁移表是唯一事实来源；非法迁移抛 PRIVACY_REQUEST_INVALID_TRANSITION。
 */
const ALLOWED_TRANSITIONS: Record<PrivacyRequestStatus, PrivacyRequestStatus[]> = {
  REQUESTED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "BLOCKED", "REJECTED"],
  BLOCKED: ["IN_PROGRESS", "REJECTED"],
  COMPLETED: [],
  CANCELLED: [],
  REJECTED: [],
};

export function canTransition(from: PrivacyRequestStatus, to: PrivacyRequestStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** 显式状态迁移 helper（唯一合法写入口）。 */
export async function transitionPrivacyRequest(
  requestId: string,
  to: PrivacyRequestStatus,
  extra?: { reasonCode?: string; handledNote?: string },
  tx?: Prisma.TransactionClient,
): Promise<PrivacyRequest> {
  const run = async (client: Prisma.TransactionClient) => {
    const current = await client.privacyRequest.findUnique({ where: { id: requestId } });

    if (!current) {
      throw governanceError("PRIVACY_REQUEST_NOT_FOUND");
    }

    if (!canTransition(current.status, to)) {
      throw governanceError("PRIVACY_REQUEST_INVALID_TRANSITION");
    }

    const completedAt = to === "COMPLETED" ? new Date() : null;

    return client.privacyRequest.update({
      where: { id: requestId },
      data: {
        status: to,
        reasonCode: extra?.reasonCode ?? (to === "COMPLETED" || to === "CANCELLED" ? null : current.reasonCode),
        handledNote: extra?.handledNote ?? current.handledNote,
        completedAt: completedAt ?? current.completedAt,
      },
    });
  };

  return tx ? run(tx) : withTransaction(run);
}

/** 用户视角的请求列表（仅本人；服务端从 session 解析 userId，不接受外部 userId）。 */
export async function listUserPrivacyRequests(userId: string): Promise<PrivacyRequest[]> {
  return prisma.privacyRequest.findMany({
    where: { userId },
    orderBy: { requestedAt: "desc" },
    take: 50,
  });
}

const ACTIVE_DELETION_STATUSES: PrivacyRequestStatus[] = ["REQUESTED", "IN_PROGRESS", "BLOCKED"];

// 注：DATA_EXPORT 没有也不允许有"只创建 REQUESTED 不执行"的低层入口——
// 同步导出的唯一执行入口是 data-export.executeSynchronousDataExport
// （REQUESTED→IN_PROGRESS→COMPLETED/REJECTED 单事务闭环）。
// 此前公开的 createDataExportRequest 已删除（footgun：会制造孤儿 REQUESTED）。
// ACCOUNT_DELETION flow 不受影响（createAccountDeletionRequest 独立实现）。

export type DeletionOutcome =
  | { status: "COMPLETED"; request: PrivacyRequest; erasure: AccountErasureResult }
  | { status: "BLOCKED"; request: PrivacyRequest; reasonCode: "ACTIVE_DATA_HOLD" | "ACTIVE_TRANSACTION_BLOCK" };

/**
 * 创建并同步执行账号注销请求。
 *
 * Phase 5 语义：请求与执行一体（无后台 worker）。执行在事务内复检
 * hold / active transactions，命中阻断则请求置 BLOCKED + reasonCode，
 * 账号数据零部分擦除（eraseAccount 抛错时不落任何写）。
 *
 * 幂等：部分唯一索引（userId WHERE type=ACCOUNT_DELETION AND status IN
 * active）兜底并发重复请求 → P2002 映射为 PRIVACY_REQUEST_ALREADY_ACTIVE。
 */
export async function createAccountDeletionRequest(userId: string): Promise<DeletionOutcome> {
  try {
    return await withTransaction(async (tx) => {
      const request = await tx.privacyRequest.create({
        data: { userId, type: "ACCOUNT_DELETION", status: "REQUESTED" },
      });

      logger.info("privacy_request_created", "privacy", {
        requestId: request.id,
        requestType: request.type,
      });

      const inProgress = await transitionPrivacyRequest(request.id, "IN_PROGRESS", undefined, tx);

      try {
        const erasure = await eraseAccount(userId, tx);
        const completed = await transitionPrivacyRequest(
          inProgress.id,
          "COMPLETED",
          undefined,
          tx,
        );

        logger.info("privacy_request_completed", "privacy", {
          requestId: completed.id,
          requestType: completed.type,
        });

        return { status: "COMPLETED" as const, request: completed, erasure };
      } catch (error) {
        const code = (error as { code?: string }).code;

        if (code === "ACTIVE_DATA_HOLD" || code === "ACTIVE_TRANSACTION_BLOCK") {
          // 阻断路径零部分擦除的结构保证：eraseAccount 的前置检查全部是
          // 只读查询且先于任何写执行——这两个错误码只可能在前置检查阶段
          // 抛出，此刻事务内还没有发生任何匿名化写。BLOCKED 状态更新因此
          // 不会与部分擦除共存。任何写入阶段抛出的其他错误会直接向上传播，
          // 由 withTransaction 整体回滚。
          const blocked = await transitionPrivacyRequest(
            inProgress.id,
            "BLOCKED",
            { reasonCode: code },
            tx,
          );

          return { status: "BLOCKED" as const, request: blocked, reasonCode: code };
        }

        throw error;
      }
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      throw governanceError("PRIVACY_REQUEST_ALREADY_ACTIVE");
    }

    throw error;
  }
}

/** 阻断原因的人类可读说明（BLOCKED 请求展示用，不含内部细节）。 */
export function describeBlockedReason(reasonCode: string | null): string {
  if (reasonCode === "ACTIVE_DATA_HOLD") {
    return "账号存在有效的法律/纠纷冻结，暂不能注销";
  }
  if (reasonCode === "ACTIVE_TRANSACTION_BLOCK") {
    return "账号存在进行中的交易，请先完成或取消后再申请注销";
  }
  return "注销请求被阻止，请联系平台支持";
}

/** 取消本人尚未开始执行的注销请求。 */
export async function cancelOwnPendingRequest(
  userId: string,
  requestId: string,
): Promise<PrivacyRequest> {
  const request = await prisma.privacyRequest.findUnique({ where: { id: requestId } });

  if (!request || request.userId !== userId) {
    throw governanceError("PRIVACY_REQUEST_NOT_FOUND");
  }

  return transitionPrivacyRequest(requestId, "CANCELLED");
}

/** 治理 seam（Phase 7 后台接入）：解除 BLOCKED → 重试。 */
export async function retryBlockedRequest(requestId: string): Promise<DeletionOutcome> {
  const request = await prisma.privacyRequest.findUnique({ where: { id: requestId } });

  if (!request) {
    throw governanceError("PRIVACY_REQUEST_NOT_FOUND");
  }

  if (request.type !== "ACCOUNT_DELETION" || request.status !== "BLOCKED") {
    throw governanceError("PRIVACY_REQUEST_INVALID_TRANSITION");
  }

  return withTransaction(async (tx) => {
    const inProgress = await transitionPrivacyRequest(requestId, "IN_PROGRESS", undefined, tx);

    try {
      const erasure = await eraseAccount(request.userId, tx);
      const completed = await transitionPrivacyRequest(inProgress.id, "COMPLETED", undefined, tx);

      logger.info("privacy_request_completed", "privacy", {
        requestId: completed.id,
        requestType: completed.type,
      });

      return { status: "COMPLETED" as const, request: completed, erasure };
    } catch (error) {
      const code = (error as { code?: string }).code;

      if (code === "ACTIVE_DATA_HOLD" || code === "ACTIVE_TRANSACTION_BLOCK") {
        const blocked = await transitionPrivacyRequest(
          inProgress.id,
          "BLOCKED",
          { reasonCode: code },
          tx,
        );
        return { status: "BLOCKED" as const, request: blocked, reasonCode: code };
      }

      throw error;
    }
  });
}

export { ACTIVE_DELETION_STATUSES };
