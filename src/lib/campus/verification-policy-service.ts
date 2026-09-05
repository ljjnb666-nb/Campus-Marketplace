import { createHash } from "node:crypto";
import type { CampusVerificationPolicy, Prisma } from "@prisma/client";

import { governanceError } from "@/lib/governance/domain-errors";
import { acquireCampusVerificationPolicyLocks } from "@/lib/governance/governance-lock";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { logger } from "@/lib/logger";
import { prisma, withTransaction } from "@/lib/prisma";

/**
 * Phase 6A：校园认证策略版本化服务（per-campus）。
 *
 * 与 Phase 5 LegalDocument 同一工程原则：
 * - PUBLISHED 即不可变：version/instructions/contentHash/effectiveAt
 *   一经发布不得原地修改，变更必须创建更高版本
 * - current 解析确定性：PUBLISHED + effectiveAt <= now 中 version 最高
 * - publish 持 policy advisory 锁（与 submitVerification 共享同一
 *   serialization boundary），锁内重读 highest published 版本，
 *   并发发布不绕过版本顺序 invariant
 *
 * 创建/发布入口 6A 仅暴露 service seam（测试/seed 使用），管理界面属于
 * Phase 7（与 Phase 5 LegalDocument 同先例）。
 */

/** canonical content 定义：instructions 的 UTF-8 原文本身（不做归一化）。 */
export function computePolicyContentHash(instructions: string): string {
  return createHash("sha256").update(instructions, "utf8").digest("hex");
}

export async function createVerificationPolicy(input: {
  campusId: string;
  version: number;
  title: string;
  instructions: string;
  effectiveAt?: Date;
  createdById?: string;
}): Promise<CampusVerificationPolicy> {
  return prisma.campusVerificationPolicy.create({
    data: {
      campusId: input.campusId,
      version: input.version,
      title: input.title,
      instructions: input.instructions,
      contentHash: computePolicyContentHash(input.instructions),
      effectiveAt: input.effectiveAt ?? new Date(),
      createdById: input.createdById,
    },
  });
}

/**
 * 发布策略：DRAFT → PUBLISHED（发布即不可变）。
 * 事务内先锁 campus（acquireCampusVerificationPolicyLocks），锁内重读
 * highest published，待发布版本号必须更高——(campusId, version) 唯一约束兜底。
 */
export async function publishVerificationPolicy(
  policyId: string,
  options: { actorId?: string } = {},
): Promise<CampusVerificationPolicy> {
  return withTransaction(async (tx) => {
    const policy = await tx.campusVerificationPolicy.findUnique({ where: { id: policyId } });

    if (!policy) {
      throw governanceError("CAMPUS_VERIFICATION_POLICY_NOT_FOUND");
    }

    if (policy.status === "PUBLISHED") {
      // 幂等：重复发布同一策略原样返回，不产生第二个 published 版本
      return policy;
    }

    if (policy.status === "RETIRED") {
      throw governanceError("CAMPUS_VERIFICATION_POLICY_ALREADY_PUBLISHED", "已退役的策略不能重新发布");
    }

    await acquireCampusVerificationPolicyLocks(tx, [policy.campusId]);

    const highestPublished = await tx.campusVerificationPolicy.findFirst({
      where: {
        campusId: policy.campusId,
        status: { in: ["PUBLISHED", "RETIRED"] },
      },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    if (highestPublished && policy.version <= highestPublished.version) {
      throw governanceError(
        "CAMPUS_VERIFICATION_POLICY_ALREADY_PUBLISHED",
        "存在不低于该版本的已发布策略，请使用更高版本号",
      );
    }

    const published = await tx.campusVerificationPolicy.update({
      where: { id: policy.id },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });

    if (options.actorId) {
      await recordAdminAudit(
        {
          actorId: options.actorId,
          action: "PUBLISH_VERIFICATION_POLICY",
          targetType: "CAMPUS_VERIFICATION_POLICY",
          targetId: published.id,
          campusId: published.campusId,
          metadata: { policyVersion: published.version },
        },
        tx,
      );
    }

    logger.info("campus_verification_policy_published", "governance", {
      policyId: published.id,
      campusId: published.campusId,
      version: published.version,
      contentHash: published.contentHash,
    });

    return published;
  });
}

/** DRAFT → RETIRED（放弃草稿）；PUBLISHED → RETIRED（下线，保留历史可查）。 */
export async function retireVerificationPolicy(
  policyId: string,
  options: { actorId?: string } = {},
): Promise<CampusVerificationPolicy> {
  return withTransaction(async (tx) => {
    const policy = await tx.campusVerificationPolicy.findUnique({
      where: { id: policyId },
      select: { id: true, campusId: true },
    });

    if (!policy) {
      throw governanceError("CAMPUS_VERIFICATION_POLICY_NOT_FOUND");
    }

    await acquireCampusVerificationPolicyLocks(tx, [policy.campusId]);

    const retired = await tx.campusVerificationPolicy.update({
      where: { id: policy.id },
      data: { status: "RETIRED" },
    });

    if (options.actorId) {
      await recordAdminAudit(
        {
          actorId: options.actorId,
          action: "RETIRE_VERIFICATION_POLICY",
          targetType: "CAMPUS_VERIFICATION_POLICY",
          targetId: retired.id,
          campusId: retired.campusId,
          metadata: { policyVersion: retired.version },
        },
        tx,
      );
    }

    return retired;
  });
}

/**
 * current 策略解析：PUBLISHED + effectiveAt <= now 中 version 最高。
 * 排序显式确定性（version desc, id asc），绝不依赖数据库返回顺序。
 * tx 变体供 submitVerification 在 policy 锁内做事务上一致的解析。
 */
export async function getCurrentVerificationPolicy(
  campusId: string,
  now: Date,
  tx?: Prisma.TransactionClient,
): Promise<CampusVerificationPolicy | null> {
  const where = {
    campusId,
    status: "PUBLISHED" as const,
    effectiveAt: { lte: now },
  };

  if (tx) {
    const rows = await tx.campusVerificationPolicy.findMany({
      where,
      orderBy: [{ version: "desc" }, { id: "asc" }],
      take: 1,
    });
    return rows[0] ?? null;
  }

  const rows = await prisma.campusVerificationPolicy.findMany({
    where,
    orderBy: [{ version: "desc" }, { id: "asc" }],
    take: 1,
  });
  return rows[0] ?? null;
}
