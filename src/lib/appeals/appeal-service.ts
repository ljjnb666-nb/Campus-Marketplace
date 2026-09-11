import { Prisma, type AppealStatus } from "@prisma/client";

import { isPunitive } from "@/lib/enforcement/enforcement-sequence";
import { appealError } from "@/lib/appeals/errors";
import { acquireGovernanceSubjectLock } from "@/lib/governance/governance-lock";
import { logger } from "@/lib/logger";
import { withTransaction } from "@/lib/prisma";
import { createNotification } from "@/repositories/notification-repository";

/**
 * Phase 6C-1B：申诉提交 / 撤回服务（user-facing domain service）。
 *
 * Owner source of truth = EnforcementAction.targetId（Appeal 不存 appellantId）：
 * 提交 / 撤回的 ownership 一律以 callerUserId == enforcementAction.targetId 判定。
 *
 * 锁纪律（与 erasure / enforcement 共享同一 serialization boundary）：
 * - submit：最小 pre-read 仅解析 target lock key → acquire USER:<targetId>
 *   governance subject lock → 锁内重读 EA / target User 才是最终资格依据
 *   （submit ‖ eraseAccount 必然线性化）；
 * - withdraw：Appeal 行 FOR UPDATE（全局 Appeal-row 锁序第一步）→ USER:<targetId>
 *   governance lock → 锁内重读 erased/deleted（post-erasure mutation = FORBIDDEN）。
 *
 * 提交语义：一个 EnforcementAction 永久至多一条 Appeal（DB unique 为最终权威），
 * 并发双提交由 advisory 锁 + 唯一约束共同裁决，loser 精确收敛 APPEAL_ALREADY_EXISTS。
 *
 * 本服务是 trusted domain seam：callerUserId 由服务端调用方传入（未来 HTTP
 * boundary 必须传 session.user.id，绝不信终端输入）。suspended-user 的
 * HTTP 自助入口属于 Phase 6C-2，本模块不修改 server-auth。
 */

export const APPEAL_STATEMENT_MAX_LENGTH = 2000;
export const APPEAL_DECISION_NOTE_MAX_LENGTH = 1000;

export type AppealRecord = {
  id: string;
  enforcementActionId: string;
  status: AppealStatus;
  createdAt: Date;
};

export type SubmitAppealInput = {
  callerUserId: string;
  enforcementActionId: string;
  statement: string;
  /** 测试 seam：subject 锁取得之后、资格复核之前的受控暂停点 */
  racePoint?: (tx: Prisma.TransactionClient) => Promise<void>;
};

export type WithdrawAppealInput = {
  callerUserId: string;
  appealId: string;
  racePoint?: (tx: Prisma.TransactionClient) => Promise<void>;
};

/**
 * P2002 是否命中指定列的唯一约束（唯一约束是并发提交的最终权威，
 * loser 精确收敛 APPEAL_ALREADY_EXISTS，绝不依赖前置 findFirst）。
 * meta.target 的真实形状随约束形态变化（字段数组 / 约束名字符串），
 * 统一拆解后要求包含目标列，防止无关唯一约束被误判吞掉。
 */
function isUniqueViolationOn(error: unknown, column: string): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }
  const raw: unknown = error.meta?.target;
  const parts = (Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [])
    .flatMap((entry) => entry.split(/[\s,_]+/))
    .filter(Boolean);
  return parts.includes(column);
}

/**
 * post-commit best-effort 通知：失败仅记结构化日志（APPEAL_NOTIFICATION_FAILED），
 * 绝不回滚 Appeal 决策 / restoration，绝不影响 command success。
 * 文案固定，绝不携带 statement / decisionNote。
 */
export async function bestEffortAppealNotification(
  event: "APPEAL_SUBMITTED" | "APPEAL_DECIDED",
  appealId: string,
  userId: string,
  title: string,
  content: string,
): Promise<boolean> {
  try {
    await withTransaction((tx) =>
      createNotification(tx, {
        userId,
        type: "SYSTEM",
        title,
        content,
      }),
    );
    return true;
  } catch (error) {
    logger.warn("申诉通知投递失败（不影响申诉流程）", "appeals", {
      event: "APPEAL_NOTIFICATION_FAILED",
      action: event,
      appealId,
      userId,
      error,
    });
    return false;
  }
}

/**
 * 提交申诉。USER:<targetId> 治理锁先于最终资格读——第一次 pre-lock 读
 * 仅用于解析锁键，绝不作为授权/资格依据。
 */
export async function submitAppeal(
  input: SubmitAppealInput,
): Promise<{ appeal: AppealRecord }> {
  const statement = (input.statement ?? "").trim();
  if (statement.length === 0 || statement.length > APPEAL_STATEMENT_MAX_LENGTH) {
    throw appealError("APPEAL_NOT_ALLOWED", {
      userMessage: `申诉内容不能为空，且不能超过 ${APPEAL_STATEMENT_MAX_LENGTH} 字`,
    });
  }

  const { appeal, targetUserId } = await withTransaction(async (tx) => {
    // 1. 最小 pre-read：仅解析 target lock key（EA append-only，不存在即不存在）
    const lockProbe = await tx.enforcementAction.findUnique({
      where: { id: input.enforcementActionId },
      select: { targetId: true },
    });
    if (!lockProbe) {
      throw appealError("APPEAL_NOT_FOUND");
    }

    // 2. USER target 治理锁（与 erasure 串行化）
    await acquireGovernanceSubjectLock(tx, "USER", lockProbe.targetId);

    if (input.racePoint) {
      await input.racePoint(tx);
    }

    // 3. 锁内重读（最终资格依据）
    const action = await tx.enforcementAction.findUnique({
      where: { id: input.enforcementActionId },
      select: { id: true, type: true, targetId: true },
    });
    if (!action) {
      throw appealError("APPEAL_NOT_FOUND");
    }

    // 4. target 存在且未 erased/deleted（合法 appellant 本身可为 SUSPENDED——
    //    User.status 不参与判定）
    const targetUser = await tx.user.findUnique({
      where: { id: action.targetId },
      select: { deletedAt: true, erasedAt: true },
    });
    if (!targetUser || targetUser.deletedAt || targetUser.erasedAt) {
      throw appealError("APPEAL_NOT_ALLOWED", { userMessage: "账号状态不允许提交申诉" });
    }

    // 5. ownership：仅 EA target 本人可提交（防枚举 404）
    if (input.callerUserId !== action.targetId) {
      throw appealError("APPEAL_NOT_OWNED");
    }

    // 6. 仅 punitive 可申诉（restorative = 别人的恢复记录，不是申诉对象）
    if (!isPunitive(action.type)) {
      throw appealError("APPEAL_NOT_ALLOWED", { userMessage: "该执法记录不可申诉" });
    }

    // 7. create；unique enforcementActionId 冲突精确收敛
    try {
      const appeal = await tx.appeal.create({
        data: {
          enforcementActionId: action.id,
          status: "SUBMITTED",
          statement,
        },
      });
      return { appeal, targetUserId: action.targetId };
    } catch (error) {
      if (isUniqueViolationOn(error, "enforcementActionId")) {
        throw appealError("APPEAL_ALREADY_EXISTS");
      }
      throw error;
    }
  });

  // post-commit best-effort：固定文案（不含 statement）
  await bestEffortAppealNotification(
    "APPEAL_SUBMITTED",
    appeal.id,
    targetUserId,
    "已收到你的申诉",
    "你提交的申诉已进入平台审核流程，审核结果将通过站内消息通知你。",
  );

  return { appeal };
}

/**
 * 撤回申诉（仅 SUBMITTED）。锁序硬合同：Appeal 行 FOR UPDATE →
 * USER target governance lock（禁止反序）。post-erasure 撤回 = FORBIDDEN：
 * 保持 SUBMITTED，由 reviewer 走 DISMISSED(APPELLANT_ERASED)。
 */
export async function withdrawAppeal(
  input: WithdrawAppealInput,
): Promise<{ appeal: AppealRecord }> {
  const appeal = await withTransaction(async (tx) => {
    // 1. Appeal 行锁（参数化 raw SQL）
    await tx.$queryRaw`SELECT "id" FROM "Appeal" WHERE "id" = ${input.appealId} FOR UPDATE`;
    const appeal = await tx.appeal.findUnique({
      where: { id: input.appealId },
      select: { id: true, status: true, enforcementActionId: true },
    });
    if (!appeal) {
      throw appealError("APPEAL_NOT_FOUND");
    }

    // 2. owner 从 immutable EnforcementAction 解析
    const action = await tx.enforcementAction.findUnique({
      where: { id: appeal.enforcementActionId },
      select: { targetId: true },
    });
    if (!action) {
      throw appealError("APPEAL_NOT_FOUND");
    }

    // 3. USER target 治理锁
    await acquireGovernanceSubjectLock(tx, "USER", action.targetId);

    if (input.racePoint) {
      await input.racePoint(tx);
    }

    // 4/5. 锁内重读 target：post-erasure 用户不得再产生任何 user-originated mutation
    const targetUser = await tx.user.findUnique({
      where: { id: action.targetId },
      select: { deletedAt: true, erasedAt: true },
    });
    if (!targetUser || targetUser.deletedAt || targetUser.erasedAt) {
      throw appealError("APPEAL_NOT_ALLOWED", { userMessage: "账号状态不允许该操作" });
    }

    // 6. ownership（caller 必须就是 EA target）
    if (input.callerUserId !== action.targetId) {
      throw appealError("APPEAL_NOT_OWNED");
    }

    // 7. 仅 SUBMITTED 可撤回（IN_REVIEW / terminal 一律 DENY）
    if (appeal.status !== "SUBMITTED") {
      throw appealError("APPEAL_INVALID_TRANSITION");
    }

    // 8–12. WITHDRAWN + 全部 decision 字段清空
    return tx.appeal.update({
      where: { id: appeal.id },
      data: {
        status: "WITHDRAWN",
        reviewedById: null,
        reviewedAt: null,
        decisionReasonCode: null,
        decisionNote: null,
      },
    });
  });

  return { appeal };
}
