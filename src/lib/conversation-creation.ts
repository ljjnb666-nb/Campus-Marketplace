import type { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";

import type { ConversationBizType } from "@/lib/conversation-key";
import { computeConversationKey } from "@/lib/conversation-key";
import {
  requireMarketplaceCapability,
  requireParticipantsMarketplaceEligible,
} from "@/lib/enforcement/capability-gate";
import {
  assertActiveAccountMutationAllowed,
} from "@/lib/governance/active-account-mutation";
import { governanceError } from "@/lib/governance/domain-errors";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { prisma, withTransaction } from "@/lib/prisma";
import { requireNewActivityAllowed } from "@/lib/feature-flags/feature-flag-guard";
import { resolveConversationCampusIdTx } from "@/lib/feature-flags/feature-flag-campus";
import { emitNotificationTx } from "@/lib/notifications/notification-service";
import { ORDER_CONVERSATION_STARTED_KIND } from "@/lib/notifications/notification-registry";
import { resolvePairBlockStateTx } from "@/lib/trust/communication-policy";

/**
 * Phase 6C-3 / Phase 8A-03：会话创建领域逻辑（从 conversation action 抽出，
 * 对齐 order-creation.ts 的"action 解析 + lib 事务领域"分层）。
 *
 * MARKETPLACE_LISTING 会话串行化模型（Planning Repair 1/2 + 8A-03 冻结）：
 *   事务外 existing fast path（可选加速，不可作为 new/existing 判定依据）
 *   → BEGIN TX
 *   → 完整 sorted 参与方 USER 治理锁（namespace 730501，与全局锁序一致；
 *     两种 gate kind 统一进入同一 pair lock domain——block / conversation
 *     create / message send 三者线性化）
 *   → assertActiveAccountMutationAllowed(actor)（完整锁集持有后的 fresh 复核，
 *     不再经 prepareActiveAccountMutation 以 actor-first 顺序重取锁）
 *   → POST-LOCK 重读 conversationKey：命中 = 既有沟通，直接放行（不做任何 gate）
 *   → miss：PAIR_BLOCK 检查（事务内、位于 create/message/notification 之前）
 *     —— 任意方向 block ⇒ 新 MARKETPLACE_LISTING contact DENY（零会话/零
 *     消息/零通知）
 *   → 锁后重读权威资源（campus + 参与关系），actor 三门专用校验（403 族）
 *     + 全参与方资格校验（对手方失效统一 409）
 *   → racePoint（测试 seam）→ conversation.create（嵌套 participants + 首条
 *     消息 + 通知）→ COMMIT；P2002 fallback 保留为兜底（同 key ⇒ 同参与方
 *     集 ⇒ 同锁集，正常不可达）。
 *
 * EXISTING_OBLIGATION（订单/租赁订单会话）= 既有义务沟通：pair 未 block 时
 * 维持原行为（不做 gate）；pair blocked 时仅在锁后义务复核确认 obligation
 * 仍然 ACTIVE 才允许创建（历史已完成订单不构成绕过 block 的新聊天通道），
 * 义务复核 = object exists + exact participants unchanged + canonical state
 * active（绝不信任 action 事务外 pre-read 的 stale status）。维持原 P2002
 * fallback 去重路径。
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

/**
 * EXISTING_OBLIGATION gate 的锁后义务复核：order/rentalOrder 权威重读，
 * 确认 object exists + exact participants unchanged + obligation ACTIVE。
 */
export type ObligationRereader = (tx: Prisma.TransactionClient) => Promise<boolean>;

export type ListingConversationGate =
  | {
      kind: "MARKETPLACE_LISTING";
      rereadResource: ListingResourceRereader;
      racePoint?: ConversationGateRacePoint;
    }
  | {
      kind: "EXISTING_OBLIGATION";
      rereadObligation: ObligationRereader;
      racePoint?: ConversationGateRacePoint;
    };

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
    /**
     * Phase 9B：通知 title/content 由 notification-registry 按
     * (bizType, bizNumber) 渲染——调用方不再传入自由文案。order 会话
     * 携带机器生成的业务编号（orderNo / orderNumber）；listing 会话不携带
     * （listing title 是 user-authored，禁止进入 notification 域）。
     */
    bizNumber?: string;
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

  // 2. 数据库事务：完整参与方锁 → 锁后重读 → 沟通策略/义务 gate → 锁内校验 → 创建
  try {
    const created = await withTransaction(async (tx) => {
      // 8A-03：sorted 参与方 USER 锁先行（两种 gate kind 同一 lock domain），
      // 禁止 actor lock → pair lock 的旧顺序（与 block/send 的 pair 锁序
      // 不一致会扩大 deadlock surface）
      await acquireGovernanceSubjectLocks(
        tx,
        participantIds.map((subjectId) => ({ subjectType: "USER", subjectId })),
      );

      // RB-03：发起者 active-account fresh 复核（完整参与方锁已持有）
      await assertActiveAccountMutationAllowed(tx, input.initialData.currentUserId);

      // POST-LOCK 重读：并发首建者已提交 → 按"既有沟通"放行（绝不做 new-activity 拒绝）
      const existingAfterLock = await tx.conversation.findUnique({
        where: { conversationKey },
        select: { id: true },
      });
      if (existingAfterLock) {
        return existingAfterLock;
      }

      // 8A-03：PAIR_BLOCK 检查——事务内、位于 create/message/notification 之前。
      // 任意方向 block ⇒ 新 listing contact DENY；EXISTING_OBLIGATION 仅在
      // 锁后义务复核 ACTIVE 时放行（历史订单不是永久 bypass token）。
      const blockState = await resolvePairBlockStateTx(
        tx,
        input.initialData.currentUserId,
        input.initialData.counterpartId,
      );
      if (blockState.pairBlocked) {
        if (gate.kind === "EXISTING_OBLIGATION") {
          const obligationActive = await gate.rereadObligation(tx);
          if (!obligationActive) {
            throw governanceError("COMMUNICATION_BLOCKED", {
              userMessage: "你们之间存在消息屏蔽，且该订单已结束，无法发起沟通",
            });
          }
        } else {
          throw governanceError("COMMUNICATION_BLOCKED", {
            userMessage: "你们之间存在消息屏蔽，无法发起新的会话沟通",
          });
        }
      }

      let newConversationCampusId: string | null = null;
      if (gate.kind === "MARKETPLACE_LISTING") {
        // 权威资源重读 + 参与关系复核（不盲信事务外 snapshot）
        const fresh = await gate.rereadResource(tx);
        if (!fresh) {
          return null;
        }
        newConversationCampusId = fresh.campusId;
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
      }

      if (gate.racePoint) {
        await gate.racePoint(tx);
      }

      // Existing obligations have no Order/RentalOrder campusId; resolve from
      // authoritative original listing/errand. Existing conversation fast-path
      // above remains permitted, but a new conversation+its first message must
      // obey BOTH gates in the transaction.
      const campusId = newConversationCampusId ?? await resolveConversationCampusIdTx(
        tx, { [bizKeyField]: bizId },
      );
      await requireNewActivityAllowed(tx, { kind: "CONVERSATION", campusId });
      await requireNewActivityAllowed(tx, { kind: "MESSAGE", campusId });

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

      // Phase 9B：canonical notification domain——title/content 由 registry
      // 按 (bizType, bizNumber) 渲染；dedupe 以 conversation 为聚合
      // （每个 conversation 只通知对手方一次）。
      await emitNotificationTx(tx, {
        kind: ORDER_CONVERSATION_STARTED_KIND,
        recipientUserId: initialData.counterpartId,
        dedupeKey: `${ORDER_CONVERSATION_STARTED_KIND}:${conv.id}:${initialData.counterpartId}`,
        payload: {
          conversationId: conv.id,
          bizType,
          ...(initialData.bizNumber ? { bizNumber: initialData.bizNumber } : {}),
        },
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
