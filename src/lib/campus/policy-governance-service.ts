import type { CampusVerificationPolicy, Prisma } from "@prisma/client";

import {
  CAMPUS_MANAGE_PERMISSION,
} from "@/lib/campus/campus-admin-access";
import {
  governanceError,
} from "@/lib/governance/domain-errors";
import {
  acquireGovernanceSubjectLocks,
  acquireCampusVerificationPolicyLocks,
} from "@/lib/governance/governance-lock";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import {
  computePolicyContentHash,
  publishVerificationPolicyInTx,
  retireVerificationPolicyInTx,
} from "@/lib/campus/verification-policy-service";
import {
  loadAuthorizationContext,
  requirePermissionInContext,
} from "@/lib/rbac/service";
import { withTransaction } from "@/lib/prisma";

/**
 * Phase 7H：认证策略治理 canonical mutation seam（actor-authenticated）。
 *
 * 既有 createVerificationPolicy / publishVerificationPolicy /
 * retireVerificationPolicy 是 service seam（测试/seed 用，不做 actor 授权）。
 * 本模块为其补 UI 触达的 canonical 入口（Planning §29-§36 冻结）：
 *
 * - 锁序（§32 冻结）：USER:actor → CAMPUS_VERIFICATION_POLICY:<campusId>
 *   （POLICY_LOCK_NAMESPACE 730502——与 submitVerification / 既有 publish /
 *   retire 共享同一 policy serialization boundary，绝不创建第二套不兼容
 *   lock namespace）→ 锁定授权重读（GLOBAL campus.manage，§30——绝不裸调
 *   既有 seam 后仅靠 action 前置鉴权）→ policy mutation → audit。
 * - 零第二套 policy state machine（§31）：publish/retire 直接复用
 *   verification-policy-service 的 InTx 变体（幂等发布 / RETIRED 禁发布 /
 *   highest published 版本顺序 invariant / current 解析语义全部同源）。
 * - 版本分配（§33）：锁内 SELECT max(version) → nextVersion = max + 1——
 *   并发 draft create 串行分配得到 N 与 N+1，而不是冲 (campusId, version)
 *   unique。客户端绝不能指定 version。
 * - 不可变性（§34）：仅 DRAFT 可编辑；PUBLISHED / RETIRED 一律
 *   CAMPUS_VERIFICATION_POLICY_IMMUTABLE（in-place edit 禁止）。instructions
 *   修改必须重算 computePolicyContentHash（§34）。
 * - 审计（§36/§58）：CREATE/UPDATE_VERIFICATION_POLICY_DRAFT /
 *   PUBLISH / RETIRE_VERIFICATION_POLICY；metadata 仅 campusId（专用列）+
 *   policyVersion——instructions/content 绝不进入 audit。
 */

function assertNonEmpty(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw governanceError("CAMPUS_INPUT_INVALID");
  }
  return trimmed;
}

/** 锁定授权重读（与 campus-governance-service 同一冻结链）。 */
async function requireCampusManageInTx(
  tx: Prisma.TransactionClient,
  actorId: string,
): Promise<void> {
  const context = await loadAuthorizationContext(actorId, tx);
  await requirePermissionInContext(context, CAMPUS_MANAGE_PERMISSION);
}

export type CreateGovernanceVerificationPolicyDraftInput = {
  actorId: string;
  campusId: string;
  title: string;
  instructions: string;
  effectiveAt?: Date;
};

/**
 * 创建 DRAFT 草稿（§33）：policy 锁内 max(version)+1 顺序分配；客户端
 * 不传入 version；contentHash 由服务器从 instructions 现算。
 */
export async function createGovernanceVerificationPolicyDraft(
  input: CreateGovernanceVerificationPolicyDraftInput,
): Promise<CampusVerificationPolicy> {
  const title = assertNonEmpty(input.title);
  const instructions = assertNonEmpty(input.instructions);

  return withTransaction(async (tx) => {
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "USER", subjectId: input.actorId },
    ]);
    await acquireCampusVerificationPolicyLocks(tx, [input.campusId]);
    await requireCampusManageInTx(tx, input.actorId);

    const campus = await tx.campus.findUnique({
      where: { id: input.campusId },
      select: { id: true },
    });
    if (!campus) {
      throw governanceError("CAMPUS_NOT_FOUND");
    }

    const highest = await tx.campusVerificationPolicy.aggregate({
      _max: { version: true },
      where: { campusId: input.campusId },
    });
    const nextVersion = (highest._max.version ?? 0) + 1;

    const policy = await tx.campusVerificationPolicy.create({
      data: {
        campusId: input.campusId,
        version: nextVersion,
        status: "DRAFT",
        title,
        instructions,
        contentHash: computePolicyContentHash(instructions),
        effectiveAt: input.effectiveAt ?? new Date(),
        createdById: input.actorId,
      },
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "CREATE_VERIFICATION_POLICY_DRAFT",
        targetType: "CAMPUS_VERIFICATION_POLICY",
        targetId: policy.id,
        campusId: policy.campusId,
        metadata: { policyVersion: policy.version },
      },
      tx,
    );

    return policy;
  });
}

export type UpdateGovernanceVerificationPolicyDraftInput = {
  actorId: string;
  policyId: string;
  title?: string;
  instructions?: string;
  effectiveAt?: Date;
};

/**
 * 编辑 DRAFT（§34）：version 不变；instructions 修改必须重算 contentHash；
 * PUBLISHED / RETIRED 一律不可变。零字段 = 幂等 no-op（无 mutation 即无
 * audit）。
 */
export async function updateGovernanceVerificationPolicyDraft(
  input: UpdateGovernanceVerificationPolicyDraftInput,
): Promise<CampusVerificationPolicy> {
  const data: {
    title?: string;
    instructions?: string;
    contentHash?: string;
    effectiveAt?: Date;
  } = {};
  if (input.title !== undefined) {
    data.title = assertNonEmpty(input.title);
  }
  if (input.instructions !== undefined) {
    const instructions = assertNonEmpty(input.instructions);
    data.instructions = instructions;
    data.contentHash = computePolicyContentHash(instructions);
  }
  if (input.effectiveAt !== undefined) {
    data.effectiveAt = input.effectiveAt;
  }

  return withTransaction(async (tx) => {
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "USER", subjectId: input.actorId },
    ]);

    // Stage A 最小锚点：仅定位 campusId（供 policy 锁）；完整重读在锁内
    const anchor = await tx.campusVerificationPolicy.findUnique({
      where: { id: input.policyId },
      select: { id: true, campusId: true },
    });
    if (!anchor) {
      throw governanceError("CAMPUS_VERIFICATION_POLICY_NOT_FOUND");
    }

    await acquireCampusVerificationPolicyLocks(tx, [anchor.campusId]);
    await requireCampusManageInTx(tx, input.actorId);

    const policy = await tx.campusVerificationPolicy.findUnique({
      where: { id: input.policyId },
    });
    if (!policy) {
      throw governanceError("CAMPUS_VERIFICATION_POLICY_NOT_FOUND");
    }
    if (policy.status !== "DRAFT") {
      // PUBLISHED / RETIRED IMMUTABLE（§34）：禁止 in-place edit
      throw governanceError("CAMPUS_VERIFICATION_POLICY_IMMUTABLE");
    }

    if (Object.keys(data).length === 0) {
      return policy;
    }

    const updated = await tx.campusVerificationPolicy.update({
      where: { id: policy.id },
      data,
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "UPDATE_VERIFICATION_POLICY_DRAFT",
        targetType: "CAMPUS_VERIFICATION_POLICY",
        targetId: updated.id,
        campusId: updated.campusId,
        metadata: { policyVersion: updated.version },
      },
      tx,
    );

    return updated;
  });
}

/**
 * 发布（§35）：锁内授权重读后复用既有 publish invariant——幂等发布、
 * RETIRED 禁发布、highest published 版本顺序、current 解析语义零变化。
 */
export async function publishGovernanceVerificationPolicy(input: {
  actorId: string;
  policyId: string;
}): Promise<CampusVerificationPolicy> {
  return withTransaction(async (tx) => {
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "USER", subjectId: input.actorId },
    ]);

    const anchor = await tx.campusVerificationPolicy.findUnique({
      where: { id: input.policyId },
      select: { id: true, campusId: true },
    });
    if (!anchor) {
      throw governanceError("CAMPUS_VERIFICATION_POLICY_NOT_FOUND");
    }

    await acquireCampusVerificationPolicyLocks(tx, [anchor.campusId]);
    await requireCampusManageInTx(tx, input.actorId);

    // 同一事务内重入 policy 锁（advisory xact lock 同事务同键立即成功）；
    // invariant 检查在「policy 锁 + 授权重读」之后由既有 InTx 变体执行
    return publishVerificationPolicyInTx(tx, input.policyId, { actorId: input.actorId });
  });
}

/**
 * 退役（§35）：既有 state truth 保持——DRAFT / PUBLISHED → RETIRED；
 * RETIRED → RETIRED 为幂等 no-op（治理语义：无 mutation 即无重复审计）。
 */
export async function retireGovernanceVerificationPolicy(input: {
  actorId: string;
  policyId: string;
}): Promise<CampusVerificationPolicy> {
  return withTransaction(async (tx) => {
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "USER", subjectId: input.actorId },
    ]);

    const anchor = await tx.campusVerificationPolicy.findUnique({
      where: { id: input.policyId },
      select: { id: true, campusId: true },
    });
    if (!anchor) {
      throw governanceError("CAMPUS_VERIFICATION_POLICY_NOT_FOUND");
    }

    await acquireCampusVerificationPolicyLocks(tx, [anchor.campusId]);
    await requireCampusManageInTx(tx, input.actorId);

    const policy = await tx.campusVerificationPolicy.findUnique({
      where: { id: input.policyId },
    });
    if (!policy) {
      throw governanceError("CAMPUS_VERIFICATION_POLICY_NOT_FOUND");
    }
    if (policy.status === "RETIRED") {
      // same-state retry = 幂等 no-op：无 mutation 即无重复审计
      return policy;
    }

    return retireVerificationPolicyInTx(tx, input.policyId, { actorId: input.actorId });
  });
}
