import type { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";

import type { ConversationBizType } from "@/lib/conversation-key";
import { computeConversationKey } from "@/lib/conversation-key";
import {
  requireMarketplaceCapability,
  requireParticipantsMarketplaceEligible,
} from "@/lib/enforcement/capability-gate";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { prisma, withTransaction } from "@/lib/prisma";
import { createNotification } from "@/repositories/notification-repository";

/**
 * Phase 6C-3：会话创建领域逻辑（从 conversation action 抽出，对齐
 * order-creation.ts 的"action 解析 + lib 事务领域"分层）。
 *
 * MARKETPLACE_LISTING 会话串行化模型（Planning Repair 1/2 冻结）：
 *   事务外 existing fast path（可选加速，不可作为 new/existing 判定依据）
 *   → BEGIN TX
 *   → 完整 sorted 参与方 USER 治理锁（namespace 730501，与全局锁序一致）
 *   → POST-LOCK 重读 conversationKey：命中 = 既有沟通，直接放行（不做任何 gate）
 *   → miss：锁后重读权威资源（campus + 参与关系），actor 三门专用校验
 *     （403 族）+ 全参与方资格校验（对手方失效统一 409）
 *   → racePoint（测试 seam）→ conversation.create（嵌套 participants + 首条
 *     消息 + 通知）→ COMMIT；P2002 fallback 保留为兜底（同 key ⇒ 同参与方
 *     集 ⇒ 同锁集，正常不可达）。
 * EXISTING_OBLIGATION（订单/租赁订单会话）= 既有义务沟通，不做 gate，
 * 维持原 P2002 fallback 去重路径。
 */

export type ConversationGateRacePoint = (tx: Prisma.TransactionClient) => Promise<void>;

/**
 * listing 资源锁后重读回调。
 * 返回 null = 权威资源已不存在 / 参与关系已失效（走既有"资源不可用"语义）；
 * 返回 fresh = 权威 campus 与权威参与方集合（用于 stale-participant fail closed）。
 */
export type ListingResourceRereader = (
  tx: Prisma.TransactionClient,
) => Promise<{
  campusId: string;
  participantIds: string[];
} | null>;

export type ListingConversationGate =
  | {
      kind: "MARKETPLACE_LISTING";
      rereadResource: ListingResourceRereader;
      racePoint?: ConversationGateRacePoint;
    }
  | { kind: "EXISTING_OBLIGATION" };

export type ConversationCreationInput = {
  bizType: ConversationBizType;
  bizKeyField:
    | "productId"
    | "errandTaskId"
    | "serviceListingId"
    | "rentalListingId"
    | "orderId"
    | "rentalOrderId";
  bizId: string;
  participantIds: string[];
  initialData: {
    title: string;
    initialMessageContent: string;
    notificationTitle: string;
    notificationContent: string;
    counterpartId: string;
    currentUserId: string;
  };
  gate: ListingConversationGate;
};

function sameParticipantSet(a: string[], b: string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** 测试/序列化 seam 导出（与 createProductOrderTx 等义务 Tx 同一约定）。 */
export async function getOrCreateConversationSafe(input: ConversationCreationInput) {
  const { bizType, bizKeyField, bizId, participantIds, initialData, gate } = input;

  // 0. 验证参与者用户账号合法性
  const validUsers = await prisma.user.findMany({
    where: { id: { in: participantIds } },
    select: { id: true },
  });
  const validUserIds = new Set(validUsers.map((u) => u.id));

  if (!validUserIds.has(initialData.currentUserId)) {
    redirect("/login");
  }

  if (!validUserIds.has(initialData.counterpartId)) {
    return null;
  }

  const conversationKey = await computeConversationKey(bizType, bizId, participantIds);

  // 1. 事务外 fast path（仅加速；new/existing 判定不依赖本读，见 POST-LOCK 重读）
  const existing = await prisma.conversation.findUnique({
    where: { conversationKey },
    select: { id: true },
  });

  if (existing) {
    return existing;
  }

  // 2. 数据库事务：完整参与方锁 → 锁后重读 → 锁内校验 → 创建
  try {
    const created = await withTransaction(async (tx) => {
      if (gate.kind === "MARKETPLACE_LISTING") {
        await acquireGovernanceSubjectLocks(
          tx,
          participantIds.map((subjectId) => ({ subjectType: "USER", subjectId })),
        );

        // POST-LOCK 重读：并发首建者已提交 → 按"既有沟通"放行（绝不做 new-activity 拒绝）
        const existingAfterLock = await tx.conversation.findUnique({
          where: { conversationKey },
          select: { id: true },
        });
        if (existingAfterLock) {
          return existingAfterLock;
        }

        // 权威资源重读 + 参与关系复核（不盲信事务外 snapshot）
        const fresh = await gate.rereadResource(tx);
        if (!fresh) {
          return null;
        }
        if (!sameParticipantSet(fresh.participantIds, participantIds)) {
          // 参与关系已变化（尤其 ERRAND publisher/accepter）→ 不给 stale
          // counterpart 新建会话，走既有"资源不可用"回退
          return null;
        }

        // actor 三门专用校验（受限 actor → MARKETPLACE_RESTRICTED 403 族）
        await requireMarketplaceCapability(
          tx,
          initialData.currentUserId,
          fresh.campusId,
          "START_NEW_MARKETPLACE_ACTIVITY",
        );
        // 全参与方资格（受限/不可用对手方 → MARKETPLACE_COUNTERPARTY_UNAVAILABLE 409）
        await requireParticipantsMarketplaceEligible(
          tx,
          participantIds,
          fresh.campusId,
          "START_NEW_MARKETPLACE_ACTIVITY",
        );

        if (gate.racePoint) {
          await gate.racePoint(tx);
        }
      }

      const conv = await tx.conversation.create({
        data: {
          title: initialData.title,
          conversationKey,
          [bizKeyField]: bizId,
          participants: {
            create: participantIds.map((pid) => ({
              userId: pid,
              lastReadAt: pid === initialData.currentUserId ? new Date() : null,
            })),
          },
          messages: {
            create: {
              senderId: initialData.currentUserId,
              type: "DIRECT",
              content: initialData.initialMessageContent,
            },
          },
        },
        select: { id: true },
      });

      await createNotification(tx, {
        userId: initialData.counterpartId,
        type: "MESSAGE",
        title: initialData.notificationTitle,
        content: initialData.notificationContent,
      });

      return conv;
    });

    return created;
  } catch (error: unknown) {
    // 捕获并发产生的 P2002 唯一键冲突，Fallback 获取先建立的会话
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      const fallback = await prisma.conversation.findUnique({
        where: { conversationKey },
        select: { id: true },
      });
      if (fallback) return fallback;
    }
    throw error;
  }
}
