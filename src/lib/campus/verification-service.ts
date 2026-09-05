import type { Prisma, UserVerification, VerificationStatus } from "@prisma/client";

import { applyVerificationAssetRetention, resolveImageTokens } from "@/lib/upload";
import {
  acquireCampusVerificationPolicyLocks,
  acquireGovernanceSubjectLock,
} from "@/lib/governance/governance-lock";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { getCurrentVerificationPolicy } from "@/lib/campus/verification-policy-service";
import { createActiveMembership } from "@/lib/campus/membership-service";
import { rbacError } from "@/lib/rbac/errors";
import {
  loadAuthorizationContext,
  requirePermissionInContext,
} from "@/lib/rbac/service";
import { createNotification } from "@/repositories/notification-repository";
import { withTransaction } from "@/lib/prisma";

/**
 * Phase 6A：校园成员认证生命周期（中央状态机 + serialization boundary）。
 *
 * 状态机（合法流转之外一律拒绝）：
 *   UNVERIFIED → PENDING                       （提交）
 *   PENDING    → VERIFIED | REJECTED           （审核决定）
 *   REJECTED   → PENDING                       （重新提交）
 *   VERIFIED   → PENDING | REVOKED             （重新提交 / 吊销）
 *   REVOKED    → PENDING                       （重新提交）
 *
 * 锁序（与 Phase 5 governance-lock 全局纪律一致）：
 *   subject 治理锁（USER:target）
 *   → policy 锁（submit：CAMPUS_VERIFICATION_POLICY:<campusId>）
 *   → 授权 / 账号状态 / membership / transition 复核
 *   → 行写 + 审计
 * 不允许任何路径按相反顺序加锁（防死锁环）。
 *
 * 并发合同：
 * - 双审核员并发决定同一申请：subject 锁串行化，第二个事务锁内重读后
 *   transition 断言失败 → 只有一个合法最终决定
 * - 审核决定 vs 账号注销：共享同一 subject 锁，严格先后——
 *   不存在"已注销账号之后变为 VERIFIED"
 * - 提交 vs 策略发布：policy 锁互斥 current 解析与证据落库
 */

export type VerificationDecision = "VERIFIED" | "REJECTED" | "REVOKED";

export const VERIFICATION_TRANSITIONS: Record<VerificationStatus, VerificationStatus[]> = {
  UNVERIFIED: ["PENDING"],
  PENDING: ["VERIFIED", "REJECTED", "PENDING"],
  REJECTED: ["PENDING"],
  VERIFIED: ["PENDING", "REVOKED"],
  REVOKED: ["PENDING"],
};

export function assertVerificationTransition(
  from: VerificationStatus,
  to: VerificationStatus,
): void {
  if (!VERIFICATION_TRANSITIONS[from]?.includes(to)) {
    throw rbacError("VERIFICATION_INVALID_TRANSITION");
  }
}

function isActiveAccount(user: {
  status: string;
  deletedAt: Date | null;
  erasedAt: Date | null;
}): boolean {
  return user.status === "ACTIVE" && user.deletedAt === null && user.erasedAt === null;
}

export type VerificationSubmissionPreparation = {
  membership: { id: string; campusId: string };
  policy: { id: string; version: number; contentHash: string } | null;
  previousStatus: VerificationStatus;
};

/**
 * 提交前置（必须在调用方事务内执行）：
 * subject 锁 → 账号 active 复核 → ACTIVE membership 解析 → policy 锁内
 * 解析 current policy → transition 断言（current → PENDING）。
 * 返回的 policy 快照必须原样落入认证证据行。
 */
export async function prepareVerificationSubmission(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<VerificationSubmissionPreparation> {
  await acquireGovernanceSubjectLock(tx, "USER", userId);

  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      status: true,
      deletedAt: true,
      erasedAt: true,
      verificationStatus: true,
    },
  });

  if (!user || !isActiveAccount(user)) {
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }

  const membership = await tx.campusMembership.findFirst({
    where: { userId, status: "ACTIVE" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, campusId: true },
  });

  if (!membership) {
    throw rbacError("MEMBERSHIP_NOT_ACTIVE");
  }

  await acquireCampusVerificationPolicyLocks(tx, [membership.campusId]);

  const policy = await getCurrentVerificationPolicy(membership.campusId, new Date(), tx);

  const existing = await tx.userVerification.findUnique({
    where: { userId },
    select: { status: true },
  });

  const previousStatus: VerificationStatus = existing?.status ?? user.verificationStatus;
  assertVerificationTransition(previousStatus, "PENDING");

  return {
    membership,
    policy: policy
      ? { id: policy.id, version: policy.version, contentHash: policy.contentHash }
      : null,
    previousStatus,
  };
}

export type SubmitVerificationInput = {
  userId: string;
  schoolName: string;
  campusName: string;
  studentIdLast4: string;
  /** 学生证材料引用（asset token，由调用方在上传体系中构建） */
  studentCardImageToken: string;
};

/**
 * 提交认证（学生侧唯一入口）：一个事务内完成
 * 状态机推进 + policy 证据快照 + 敏感资产绑定 + 用户投影 + 通知。
 * 无 ACTIVE membership / 账号非 active / 非法 transition 一律失败零写回滚。
 */
export async function submitMembershipVerification(
  input: SubmitVerificationInput,
): Promise<UserVerification> {
  return withTransaction(async (tx) => {
    const prepared = await prepareVerificationSubmission(tx, input.userId);
    const submittedAt = new Date();

    const policyEvidence = {
      policyId: prepared.policy?.id ?? null,
      policyVersion: prepared.policy?.version ?? null,
      policyHash: prepared.policy?.contentHash ?? null,
    };

    const verification = await tx.userVerification.upsert({
      where: { userId: input.userId },
      update: {
        schoolName: input.schoolName,
        campusName: input.campusName,
        studentIdLast4: input.studentIdLast4,
        status: "PENDING",
        reviewNote: null,
        reasonCode: null,
        reviewedAt: null,
        reviewedById: null,
        submittedAt,
        ...policyEvidence,
      },
      create: {
        userId: input.userId,
        membershipId: prepared.membership.id,
        schoolName: input.schoolName,
        campusName: input.campusName,
        studentIdLast4: input.studentIdLast4,
        studentCardImage: input.studentCardImageToken,
        status: "PENDING",
        submittedAt,
        ...policyEvidence,
      },
    });

    await tx.user.update({
      where: { id: input.userId },
      data: {
        schoolName: input.schoolName,
        studentIdLast4: input.studentIdLast4,
        verificationStatus: "PENDING",
      },
    });

    // 学生证图片为私有资源：token 解析为 asset: 引用并绑定认证记录
    const [studentCardImage] = await resolveImageTokens({
      ownerId: input.userId,
      tokens: [input.studentCardImageToken],
      target: { type: "verification", id: verification.id },
      tx,
    });

    const finalVerification = await tx.userVerification.update({
      where: { id: verification.id },
      data: { studentCardImage: studentCardImage ?? input.studentCardImageToken },
    });

    await createNotification(tx, {
      userId: input.userId,
      type: "SYSTEM",
      title: "认证材料已提交",
      content: "你的校园认证材料已提交，平台会尽快完成审核，请留意后续通知。",
    });

    return finalVerification;
  });
}

export type DecideVerificationInput = {
  actorId: string;
  verificationId: string;
  decision: VerificationDecision;
  reviewNote?: string | null;
  /** 机器可读拒绝/吊销原因码（不包含敏感材料内容） */
  reasonCode?: string | null;
  /** 测试 seam：锁与全部复核之后、首个写之前的受控暂停点（并发测试用） */
  racePoint?: (tx: Prisma.TransactionClient) => Promise<void>;
};

/**
 * 审核决定（approve / reject / revoke 的唯一入口）。
 *
 * 顺序：读目标（定位 subject）→ subject 锁 → 授权复核
 * （verification.review，campus-scoped 授权按 membership.campusId 校验）
 * → 锁内重读 target + verification → 账号 active 复核 → transition 断言
 * → 写 + 用户投影 + 审计 + 通知 + 敏感材料保留期。
 */
export async function decideMembershipVerification(
  input: DecideVerificationInput,
): Promise<UserVerification> {
  return withTransaction(async (tx) => {
    const located = await tx.userVerification.findUnique({
      where: { id: input.verificationId },
      select: {
        id: true,
        userId: true,
        membership: { select: { campusId: true } },
      },
    });

    if (!located) {
      throw rbacError("VERIFICATION_NOT_FOUND");
    }

    // 自审拒绝（含自吊销）：任何人不得决定自己的认证申请
    if (located.userId === input.actorId) {
      throw rbacError("VERIFICATION_SELF_REVIEW_DENIED");
    }

    // subject 治理锁（与 erasure / hold / submit 同一把锁，全局锁序一致）
    await acquireGovernanceSubjectLock(tx, "USER", located.userId);

    const actorContext = await loadAuthorizationContext(input.actorId, tx);
    await requirePermissionInContext(
      actorContext,
      "verification.review",
      located.membership.campusId,
    );

    // 锁内重读 target 账号状态（erased/deleted/suspended → fail closed）
    const target = await tx.user.findUnique({
      where: { id: located.userId },
      select: { status: true, deletedAt: true, erasedAt: true },
    });

    if (!target || !isActiveAccount(target)) {
      throw rbacError("AUTH_ACCOUNT_INACTIVE");
    }

    const current = await tx.userVerification.findUnique({
      where: { id: located.id },
    });

    if (!current) {
      throw rbacError("VERIFICATION_NOT_FOUND");
    }

    assertVerificationTransition(current.status, input.decision);

    if (input.racePoint) {
      await input.racePoint(tx);
    }

    const reviewedAt = new Date();

    const updated = await tx.userVerification.update({
      where: { id: current.id },
      data: {
        status: input.decision,
        reviewNote: input.reviewNote || null,
        reasonCode: input.reasonCode || null,
        reviewedAt,
        reviewedById: input.actorId,
      },
    });

    // 用户投影与认证行同事务更新（同一写路径，禁止旁路赋值）
    await tx.user.update({
      where: { id: current.userId },
      data: { verificationStatus: input.decision },
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action:
          input.decision === "VERIFIED"
            ? "APPROVE_VERIFICATION"
            : input.decision === "REJECTED"
              ? "REJECT_VERIFICATION"
              : "REVOKE_VERIFICATION",
        targetType: "USER_VERIFICATION",
        targetId: current.id,
        campusId: located.membership.campusId,
        detail: input.reviewNote || null,
        metadata: {
          decision: input.decision,
          policyVersion: current.policyVersion,
          targetUserId: current.userId,
        },
      },
      tx,
    );

    await createNotification(tx, {
      userId: current.userId,
      type: "SYSTEM",
      title:
        input.decision === "VERIFIED"
          ? "校园认证已通过"
          : input.decision === "REJECTED"
            ? "校园认证未通过"
            : "校园认证已被吊销",
      content:
        input.decision === "VERIFIED"
          ? "你的校园认证已通过审核，平台会向其他同学展示你的认证状态。"
          : input.decision === "REJECTED"
            ? `你的校园认证未通过审核。${
                input.reviewNote ? `原因：${input.reviewNote}` : "请完善材料后重新提交。"
              }`
            : `你的校园认证已被平台吊销。${
                input.reviewNote ? `原因：${input.reviewNote}` : ""
              }`,
    });

    // 敏感材料保留期：出结果后 VERIFICATION_ASSET_RETENTION_DAYS 天由 cleanup
    // 删除学生证原图（认证结论保留，见 docs/STORAGE.md）
    await applyVerificationAssetRetention(tx, current.id, reviewedAt);

    return updated;
  });
}

/** 供 seed / fixture 使用：确保用户在其校区上持有 ACTIVE membership（幂等）。 */
export async function ensureActiveMembership(
  tx: Prisma.TransactionClient,
  userId: string,
  campusId: string,
): Promise<void> {
  const existing = await tx.campusMembership.findUnique({
    where: { userId_campusId: { userId, campusId } },
    select: { id: true },
  });
  if (existing) {
    return;
  }
  await createActiveMembership(tx, { userId, campusId });
}
