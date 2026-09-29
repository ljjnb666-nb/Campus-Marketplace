import type { Prisma } from "@prisma/client";

import { assertActiveAccountMutationAllowed } from "@/lib/governance/active-account-mutation";
import { governanceError } from "@/lib/governance/domain-errors";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { withTransaction } from "@/lib/prisma";
import {
  resolveConversationCommunicationPolicyTx,
  type ConversationObligationRefs,
} from "@/lib/trust/communication-policy";

/**
 * Phase 8A-03（P8-B03）：消息发送的真正事务内 authority（从 conversation
 * action 抽出；对齐 conversation-creation.ts / order-creation.ts 分层）。
 *
 * 旧结构（已废除）：事务外 participant read + 单向 block read → 另起事务
 * 写消息——block check 与 send 之间存在 TOCTOU，且只检查
 * "counterpart blocked sender"单向（A blocks B 时 A 仍可给 B 发消息）。
 *
 * 新合同（与 block / conversation create 同一 sorted pair USER lock domain
 * 线性化，namespace 730501）：
 *
 *   BEGIN TX
 *   → conversation participant pair discovery（仅读；不写）
 *   → sorted pair USER locks（升序，统一经 acquireGovernanceSubjectLocks）
 *   → assertActiveAccountMutationAllowed(sender)（锁内 fresh 复核）
 *   → POST-LOCK 重读：conversation exists + sender participant + 1:1
 *     participant set 不变（0/1/>2/changed ⇒ fail closed，绝不"取第一个
 *     counterpart"后继续写）
 *   → effective block relation（双向派生：A→B OR B→A）
 *   → ¬pairBlocked → ALLOW
 *   → pairBlocked → ACTIVE_EXISTING_OBLIGATION（数据库 authoritative state
 *     锁内推导）→ active: ALLOW（双向临时履约例外）／否则: DENY
 *   → Message.create + Conversation.updatedAt + sender lastReadAt → COMMIT
 *
 * 关键词过滤等 content validation 保留在 action 层事务外（inexpensive
 * precheck）；block authorization / participant authority / obligation
 * authority 全部在事务 + 锁边界内完成。
 */

export type MessageSendDeniedReason =
  | "CONVERSATION_NOT_FOUND"
  | "PARTICIPANT_SET_INVALID";

/** 会话访问权/参与方结构失败（非治理政策；调用方映射为既有文案）。 */
export class MessageSendDeniedError extends Error {
  readonly reason: MessageSendDeniedReason;

  constructor(reason: MessageSendDeniedReason, userMessage: string) {
    super(userMessage);
    this.name = "MessageSendDeniedError";
    this.reason = reason;
  }
}

/** 测试/序列化 seam（生产一律不传）。 */
export type SendMessageSeams = {
  /** 锁 + fresh authority 读之后、block policy 解析前挂起。 */
  afterLock?: (tx: Prisma.TransactionClient) => Promise<void>;
  /** 政策判定通过后、首个 durable 写前挂起。 */
  beforeWrite?: (tx: Prisma.TransactionClient) => Promise<void>;
};

export type SendMessageTxInput = {
  conversationId: string;
  senderId: string;
  content: string;
  seams?: SendMessageSeams;
};

function sameParticipantSet(a: string[], b: string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export async function sendMessageTx(input: SendMessageTxInput): Promise<{ messageId: string }> {
  const { conversationId, senderId, content, seams } = input;

  return withTransaction(async (tx) => {
    // 1. discovery（仅读）：conversation + participant pair
    const discovery = await tx.conversation.findFirst({
      where: {
        id: conversationId,
        participants: { some: { userId: senderId } },
      },
      select: { participants: { select: { userId: true } } },
    });

    if (!discovery) {
      throw new MessageSendDeniedError(
        "CONVERSATION_NOT_FOUND",
        "无权在该会话中发送消息",
      );
    }

    const discoveryPairIds = discovery.participants.map((p) => p.userId);
    // 1:1 conversation contract：0/1/>2 一律 fail closed
    if (discoveryPairIds.length !== 2) {
      throw new MessageSendDeniedError(
        "PARTICIPANT_SET_INVALID",
        "会话参与方状态异常，无法发送消息",
      );
    }
    const counterpartId = discoveryPairIds.find((id) => id !== senderId);
    if (!counterpartId) {
      throw new MessageSendDeniedError(
        "PARTICIPANT_SET_INVALID",
        "会话参与方状态异常，无法发送消息",
      );
    }

    // 2. sorted pair USER locks（与 block / conversation create 同一 lock domain）
    await acquireGovernanceSubjectLocks(
      tx,
      discoveryPairIds.map((subjectId) => ({ subjectType: "USER", subjectId })),
    );

    // 3. sender active-account fresh 复核（完整参与方锁已持有）
    await assertActiveAccountMutationAllowed(tx, senderId);

    // 4. POST-LOCK 重读：conversation exists + sender participant + exact pair 不变
    const fresh = await tx.conversation.findUnique({
      where: { id: conversationId },
      select: {
        productId: true,
        errandTaskId: true,
        serviceListingId: true,
        rentalListingId: true,
        orderId: true,
        rentalOrderId: true,
        participants: { select: { userId: true } },
      },
    });

    if (!fresh) {
      throw new MessageSendDeniedError(
        "CONVERSATION_NOT_FOUND",
        "无权在该会话中发送消息",
      );
    }

    const freshPairIds = fresh.participants.map((p) => p.userId);
    if (
      freshPairIds.length !== 2 ||
      !freshPairIds.includes(senderId) ||
      !sameParticipantSet(freshPairIds, discoveryPairIds)
    ) {
      throw new MessageSendDeniedError(
        "PARTICIPANT_SET_INVALID",
        "会话参与方状态异常，无法发送消息",
      );
    }

    if (seams?.afterLock) {
      await seams.afterLock(tx);
    }

    // 5. effective communication policy（双向 block 派生 + obligation override，
    //    全部由数据库 authoritative state 锁内推导）
    const refs: ConversationObligationRefs = {
      productId: fresh.productId,
      errandTaskId: fresh.errandTaskId,
      serviceListingId: fresh.serviceListingId,
      rentalListingId: fresh.rentalListingId,
      orderId: fresh.orderId,
      rentalOrderId: fresh.rentalOrderId,
    };
    const policy = await resolveConversationCommunicationPolicyTx(
      tx,
      refs,
      senderId,
      counterpartId,
    );

    if (!policy.canSendMessage) {
      // BLOCKED mode：双向 DENY（blocker→blocked 与 blocked→blocker 同责）
      throw governanceError("COMMUNICATION_BLOCKED", {
        userMessage: "你们之间存在消息屏蔽，无法发送消息",
      });
    }

    if (seams?.beforeWrite) {
      await seams.beforeWrite(tx);
    }

    // 6. durable writes（同一事务边界）
    const message = await tx.message.create({
      data: {
        conversationId,
        senderId,
        type: "DIRECT",
        content,
      },
      select: { id: true },
    });

    await tx.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    await tx.conversationParticipant.updateMany({
      where: { conversationId, userId: senderId },
      data: { lastReadAt: new Date() },
    });

    return { messageId: message.id };
  });
}
