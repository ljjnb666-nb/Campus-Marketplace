import type {
  Prisma,
  SupportResolutionCode,
  SupportTicketCategory,
  SupportTicketStatus,
} from "@prisma/client";

import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { prisma, withTransaction } from "@/lib/prisma";
import { rbacError } from "@/lib/rbac/errors";
import {
  loadAuthorizationContext,
  requirePermissionInContext,
} from "@/lib/rbac/service";
import { supportTicketError } from "@/lib/support/errors";
import { SUPPORT_MANAGE_PERMISSION } from "@/lib/support/support-access";
import { computeSupportTicketDueAt } from "@/lib/support/support-sla";
import { createNotification } from "@/repositories/notification-repository";

/**
 * Phase 7G：支持工单 canonical 服务（create / claim / release / resolve /
 * close + requester 读模型）。SupportTicket = support workflow truth
 * （≠ Dispute；两个独立 workflow 域，禁止互相 cast）。
 *
 * 冻结合同：
 * - 创建（abuse guard）：USER:requester 治理锁 → active account recheck →
 *   campusId 提供时 active membership recheck → active（OPEN/IN_PROGRESS）
 *   工单计数 < MAX_ACTIVE_SUPPORT_TICKETS_PER_USER(=3) → create。
 *   计数与创建同锁同事务——并发不得绕过 3 条上限。
 * - scope：campusId 省略 → UNSCOPED（null + 'UNSCOPED'）；提供 campusId →
 *   snapshot (campusId, 'CAMPUS:<id>')。禁止从 User.campusId 自动猜 scope。
 * - 锁序（与 erasure / role revoke / dispute 决策同一全序，禁止反序）：
 *     claim/release：USER:actor → ticket 行 FOR UPDATE → racePoint → 锁后授权
 *     resolve/close：ONE sorted set（USER:actor + USER:requester）→ ticket 行
 *       FOR UPDATE → racePoint → 锁后授权（与 account erasure 串行——requester
 *       的注销必须与本域终局决策严格线性化）
 * - 状态机：claim OPEN→IN_PROGRESS（他人已领 fail closed；self 幂等）；
 *   release 仅 assignee（IN_PROGRESS→OPEN）；resolve/close 从 OPEN|IN_PROGRESS
 *   直接可达 terminal；terminal 不可 reopen；dueAt 不因 claim/release 重置。
 * - 字段分离冻结：resolutionMessage = USER_VISIBLE（requester 读面可返回）；
 *   internalNote = OPERATOR_ONLY（任何 requester 读面结构性不返回）。
 * - UNSCOPED 工单仅 GLOBAL support.manage 可见/可处理；CAMPUS 工单
 *   GLOBAL OR exact campus。
 */

/** 冻结：每用户 active 工单上限（指令冻结；扩列须显式重新 review）。 */
export const MAX_ACTIVE_SUPPORT_TICKETS_PER_USER = 3;

const ACTIVE_TICKET_STATUSES: SupportTicketStatus[] = ["OPEN", "IN_PROGRESS"];

const TERMINAL_TICKET_STATUSES: ReadonlySet<string> = new Set(["RESOLVED", "CLOSED"]);

export const UNSCOPED_TICKET_SCOPE_KEY = "UNSCOPED";

export type SupportTicketRacePoint = (tx: Prisma.TransactionClient) => Promise<void>;

/** 锁后授权重读（fail closed）：UNSCOPED 仅 GLOBAL；CAMPUS 精确匹配。 */
async function requireSupportManageAuthorization(
  tx: Prisma.TransactionClient,
  actorId: string,
  scope: { campusId: string | null; scopeKey: string },
): Promise<void> {
  const context = await loadAuthorizationContext(actorId, tx);
  if (!context || !context.accountActive) {
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }
  if (scope.scopeKey === UNSCOPED_TICKET_SCOPE_KEY) {
    if (scope.campusId !== null) {
      // malformed pair：fail closed（DB CHECK 下结构不可达，纵深防御）
      throw rbacError("AUTH_PERMISSION_DENIED");
    }
    // UNSCOPED → campusId=null → requirePermissionInContext 仅放行 GLOBAL grant
    await requirePermissionInContext(context, SUPPORT_MANAGE_PERMISSION, null);
    return;
  }
  if (scope.campusId === null || scope.scopeKey !== `CAMPUS:${scope.campusId}`) {
    throw rbacError("AUTH_PERMISSION_DENIED");
  }
  await requirePermissionInContext(context, SUPPORT_MANAGE_PERMISSION, scope.campusId);
}

// ── 创建（authenticated user-facing）──────────────────────────────────────────

export type CreateSupportTicketInput = {
  requesterId: string;
  category: SupportTicketCategory;
  subject: string;
  description: string;
  /** 省略 = UNSCOPED；提供时 requester 必须持有该校区的 ACTIVE membership */
  campusId?: string;
  racePoint?: SupportTicketRacePoint;
};

export async function createSupportTicket(
  input: CreateSupportTicketInput,
): Promise<{ id: string; scopeKey: string; campusId: string | null; dueAt: Date }> {
  return withTransaction(async (tx) => {
    // 1. USER:requester 治理锁（与 erasure / 其它写路径同锁序串行）
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "USER", subjectId: input.requesterId },
    ]);

    // 2. active account recheck（锁内，TOCTOU 关闭）
    const context = await loadAuthorizationContext(input.requesterId, tx);
    if (!context || !context.accountActive) {
      throw rbacError("AUTH_ACCOUNT_INACTIVE");
    }

    // 3. optional active campus membership recheck（禁止从 User.campusId 猜）
    let campusId: string | null = null;
    let scopeKey = UNSCOPED_TICKET_SCOPE_KEY;
    if (input.campusId) {
      if (!context.activeCampusIds.includes(input.campusId)) {
        throw supportTicketError("SUPPORT_CAMPUS_MEMBERSHIP_INACTIVE");
      }
      campusId = input.campusId;
      scopeKey = `CAMPUS:${campusId}`;
    }

    // 4. active 计数（锁内；并发不得绕过上限）
    const activeCount = await tx.supportTicket.count({
      where: { requesterId: input.requesterId, status: { in: ACTIVE_TICKET_STATUSES } },
    });
    if (activeCount >= MAX_ACTIVE_SUPPORT_TICKETS_PER_USER) {
      throw supportTicketError("SUPPORT_TICKET_LIMIT_EXCEEDED");
    }

    if (input.racePoint) {
      await input.racePoint(tx);
    }

    // 5. create（dueAt = createdAt + 72h，唯一运行时写路径）
    const now = new Date();
    const ticket = await tx.supportTicket.create({
      data: {
        requesterId: input.requesterId,
        campusId,
        scopeKey,
        category: input.category,
        status: "OPEN",
        subject: input.subject,
        description: input.description,
        dueAt: computeSupportTicketDueAt(now),
        createdAt: now,
      },
      select: { id: true, dueAt: true },
    });

    return { id: ticket.id, scopeKey, campusId, dueAt: ticket.dueAt };
  });
}

// ── claim / release（operator，USER:actor → ticket 行锁）──────────────────────

type LockedTicketRow = {
  id: string;
  campusId: string | null;
  scopeKey: string;
  status: string;
  assignedToId: string | null;
  requesterId: string;
};

async function lockTicketForOperator(
  tx: Prisma.TransactionClient,
  input: { actorId: string; ticketId: string; racePoint?: SupportTicketRacePoint },
): Promise<LockedTicketRow> {
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: input.actorId },
  ]);

  const rows = await tx.$queryRaw<
    {
      id: string;
      campusId: string | null;
      scopeKey: string;
      status: string;
      assignedToId: string | null;
      requesterId: string;
    }[]
  >`
    SELECT "id", "campusId", "scopeKey", "status", "assignedToId", "requesterId"
    FROM "SupportTicket"
    WHERE "id" = ${input.ticketId}
    FOR UPDATE`;
  const locked = rows[0];
  if (!locked) {
    // 反 oracle：missing 与越权统一安全文案（action 层不区分）
    throw supportTicketError("SUPPORT_TICKET_NOT_FOUND");
  }

  if (input.racePoint) {
    await input.racePoint(tx);
  }

  await requireSupportManageAuthorization(tx, input.actorId, {
    campusId: locked.campusId,
    scopeKey: locked.scopeKey,
  });

  return locked;
}

export async function claimSupportTicket(input: {
  actorId: string;
  ticketId: string;
  racePoint?: SupportTicketRacePoint;
}): Promise<{ ticketId: string; assignedToId: string | null; outcome: "CLAIMED" | "ALREADY_YOURS" }> {
  return withTransaction(async (tx) => {
    const locked = await lockTicketForOperator(tx, input);

    if (TERMINAL_TICKET_STATUSES.has(locked.status)) {
      throw supportTicketError("SUPPORT_TICKET_TERMINAL");
    }
    if (locked.assignedToId === input.actorId) {
      return { ticketId: locked.id, assignedToId: locked.assignedToId, outcome: "ALREADY_YOURS" };
    }
    if (locked.assignedToId !== null) {
      throw supportTicketError("SUPPORT_TICKET_ALREADY_CLAIMED");
    }

    await tx.supportTicket.update({
      where: { id: locked.id },
      data: { assignedToId: input.actorId, status: "IN_PROGRESS" },
      select: { id: true },
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "SUPPORT_TICKET_CLAIMED",
        targetType: "SUPPORT_TICKET",
        targetId: locked.id,
        campusId: locked.campusId,
      },
      tx,
    );

    return { ticketId: locked.id, assignedToId: input.actorId, outcome: "CLAIMED" };
  });
}

export async function releaseSupportTicket(input: {
  actorId: string;
  ticketId: string;
  racePoint?: SupportTicketRacePoint;
}): Promise<{ ticketId: string; assignedToId: string | null; outcome: "RELEASED" | "ALREADY_RELEASED" }> {
  return withTransaction(async (tx) => {
    const locked = await lockTicketForOperator(tx, input);

    if (TERMINAL_TICKET_STATUSES.has(locked.status)) {
      throw supportTicketError("SUPPORT_TICKET_TERMINAL");
    }
    if (locked.assignedToId === null) {
      return { ticketId: locked.id, assignedToId: null, outcome: "ALREADY_RELEASED" };
    }
    if (locked.assignedToId !== input.actorId) {
      throw supportTicketError("SUPPORT_TICKET_RELEASE_FORBIDDEN");
    }

    await tx.supportTicket.update({
      where: { id: locked.id },
      data: { assignedToId: null, status: "OPEN" },
      select: { id: true },
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "SUPPORT_TICKET_RELEASED",
        targetType: "SUPPORT_TICKET",
        targetId: locked.id,
        campusId: locked.campusId,
      },
      tx,
    );

    return { ticketId: locked.id, assignedToId: null, outcome: "RELEASED" };
  });
}

// ── resolve / close（operator，ONE sorted set：actor + requester）──────────────

export type ResolveSupportTicketInput = {
  actorId: string;
  ticketId: string;
  resolutionCode: SupportResolutionCode;
  /** USER_VISIBLE：requester 读面可返回（队列结构性不含） */
  resolutionMessage?: string | null;
  /** OPERATOR_ONLY：任何 requester 读面结构性不返回 */
  internalNote?: string | null;
  racePoint?: SupportTicketRacePoint;
};

/**
 * TxLocked 终局内核共享前段：pre-read only for lock discovery → ONE sorted set
 * （USER:actor + USER:requester）→ ticket FOR UPDATE → racePoint → 锁后授权。
 * 与 account erasure / role revoke 串行（requester 锁共享）。
 */
async function withTicketResolutionAuthority(
  tx: Prisma.TransactionClient,
  input: { actorId: string; ticketId: string; racePoint?: SupportTicketRacePoint },
): Promise<LockedTicketRow> {
  // pre-read only for lock discovery（ticket id → requester 锁键）
  const probe = await tx.supportTicket.findUnique({
    where: { id: input.ticketId },
    select: { requesterId: true },
  });
  if (!probe) {
    throw supportTicketError("SUPPORT_TICKET_NOT_FOUND");
  }

  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: input.actorId },
    { subjectType: "USER", subjectId: probe.requesterId },
  ]);

  const rows = await tx.$queryRaw<LockedTicketRow[]>`
    SELECT "id", "campusId", "scopeKey", "status", "assignedToId", "requesterId"
    FROM "SupportTicket"
    WHERE "id" = ${input.ticketId}
    FOR UPDATE`;
  const locked = rows[0];
  if (!locked) {
    throw supportTicketError("SUPPORT_TICKET_NOT_FOUND");
  }
  // 锁键与现势不一致 → 取错了锁，fail closed（requester 不可变，结构上不可达）
  if (locked.requesterId !== probe.requesterId) {
    throw supportTicketError("SUPPORT_TICKET_INVALID_TRANSITION");
  }

  if (input.racePoint) {
    await input.racePoint(tx);
  }

  await requireSupportManageAuthorization(tx, input.actorId, {
    campusId: locked.campusId,
    scopeKey: locked.scopeKey,
  });

  return locked;
}

export async function resolveSupportTicket(
  input: ResolveSupportTicketInput,
): Promise<{ ticketId: string; status: "RESOLVED" }> {
  return withTransaction(async (tx) => {
    const locked = await withTicketResolutionAuthority(tx, input);

    if (TERMINAL_TICKET_STATUSES.has(locked.status)) {
      throw supportTicketError("SUPPORT_TICKET_TERMINAL");
    }

    await tx.supportTicket.update({
      where: { id: locked.id },
      data: {
        status: "RESOLVED",
        resolutionCode: input.resolutionCode,
        resolutionMessage: input.resolutionMessage || null,
        internalNote: input.internalNote || null,
        resolvedById: input.actorId,
        resolvedAt: new Date(),
      },
      select: { id: true },
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "SUPPORT_TICKET_RESOLVED",
        targetType: "SUPPORT_TICKET",
        targetId: locked.id,
        campusId: locked.campusId,
        metadata: {
          resolutionCode: input.resolutionCode,
          // 机器可读指针；description/message/note 自由文本结构性不可进入
          sourceType: "SUPPORT_TICKET",
          sourceId: locked.id,
        },
      },
      tx,
    );

    // FR04：通知是事件信号，不是第二份内容存储——resolutionMessage /
    // description / internalNote 等 user/operator 自由文本绝不复制进
    // Notification.content（唯一权威用户可见 resolution 文本 =
    // SupportTicket.resolutionMessage，由 requester 读面按需返回；
    // erasure scrub 只需收敛该权威列，通知侧从不存在自由文本）。
    await createNotification(tx, {
      userId: locked.requesterId,
      type: "SYSTEM",
      title: "支持工单已处理",
      content: "你的支持工单已处理完成，请进入工单详情查看处理结果。",
    });

    return { ticketId: locked.id, status: "RESOLVED" };
  });
}

export async function closeSupportTicket(input: {
  actorId: string;
  ticketId: string;
  /** OPERATOR_ONLY */
  internalNote?: string | null;
  racePoint?: SupportTicketRacePoint;
}): Promise<{ ticketId: string; status: "CLOSED" }> {
  return withTransaction(async (tx) => {
    const locked = await withTicketResolutionAuthority(tx, input);

    if (TERMINAL_TICKET_STATUSES.has(locked.status)) {
      throw supportTicketError("SUPPORT_TICKET_TERMINAL");
    }

    await tx.supportTicket.update({
      where: { id: locked.id },
      data: {
        status: "CLOSED",
        internalNote: input.internalNote || null,
        resolvedById: input.actorId,
        resolvedAt: new Date(),
      },
      select: { id: true },
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "SUPPORT_TICKET_CLOSED",
        targetType: "SUPPORT_TICKET",
        targetId: locked.id,
        campusId: locked.campusId,
        metadata: {
          sourceType: "SUPPORT_TICKET",
          sourceId: locked.id,
        },
      },
      tx,
    );

    return { ticketId: locked.id, status: "CLOSED" };
  });
}

// ── requester 读模型（OWN 数据面；internalNote 结构性不返回）──────────────────

export type OwnSupportTicketListItem = {
  id: string;
  category: SupportTicketCategory;
  status: SupportTicketStatus;
  subject: string;
  campusName: string | null;
  createdAt: Date;
  dueAt: Date;
  overdue: boolean;
};

/** 本人工单列表（internalNote / resolutionMessage 均不在列表 DTO 内）。 */
export async function listOwnSupportTickets(requesterId: string): Promise<OwnSupportTicketListItem[]> {
  const rows = await prisma.supportTicket.findMany({
    where: { requesterId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
    select: {
      id: true,
      category: true,
      status: true,
      subject: true,
      createdAt: true,
      dueAt: true,
      campus: { select: { name: true } },
    },
  });

  const now = new Date();
  return rows.map((row) => ({
    id: row.id,
    category: row.category,
    status: row.status,
    subject: row.subject,
    campusName: row.campus?.name ?? null,
    createdAt: row.createdAt,
    dueAt: row.dueAt,
    overdue:
      (row.status === "OPEN" || row.status === "IN_PROGRESS") && row.dueAt < now,
  }));
}

export type OwnSupportTicketDetail = {
  id: string;
  category: SupportTicketCategory;
  status: SupportTicketStatus;
  subject: string;
  description: string;
  campusName: string | null;
  createdAt: Date;
  dueAt: Date;
  overdue: boolean;
  resolution: {
    code: SupportResolutionCode | null;
    /** USER_VISIBLE（internalNote 永不出现在 requester 读面） */
    message: string | null;
    resolvedAt: Date | null;
  } | null;
};

/**
 * 本人工单详情。select 结构性不含 internalNote / assignedToId（字段分离冻结）；
 * 非本人查询返回 null（调用方映射 notFound，无存在性 oracle）。
 */
export async function loadOwnSupportTicket(
  requesterId: string,
  ticketId: string,
): Promise<OwnSupportTicketDetail | null> {
  const row = await prisma.supportTicket.findFirst({
    where: { id: ticketId, requesterId },
    select: {
      id: true,
      category: true,
      status: true,
      subject: true,
      description: true,
      createdAt: true,
      dueAt: true,
      campus: { select: { name: true } },
      resolutionCode: true,
      resolutionMessage: true,
      resolvedAt: true,
    },
  });

  if (!row) {
    return null;
  }

  const now = new Date();
  return {
    id: row.id,
    category: row.category,
    status: row.status,
    subject: row.subject,
    description: row.description,
    campusName: row.campus?.name ?? null,
    createdAt: row.createdAt,
    dueAt: row.dueAt,
    overdue:
      (row.status === "OPEN" || row.status === "IN_PROGRESS") && row.dueAt < now,
    resolution:
      row.resolvedAt !== null
        ? {
            code: row.resolutionCode,
            message: row.resolutionMessage,
            resolvedAt: row.resolvedAt,
          }
        : null,
  };
}
