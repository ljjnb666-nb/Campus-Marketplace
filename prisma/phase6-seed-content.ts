/**
 * Phase 6A 校园认证策略：初始工程治理基线内容。
 *
 * 供 prisma/seed.ts 与 scripts/e2e-setup.ts 共用（tsx 无 @/ alias，
 * 本模块只使用相对导入与 @prisma/client，与 legal-seed-content.ts 同约定）。
 *
 * 发布即不可变：本 helper 只做"不存在则发布 v1"，绝不改写已发布内容；
 * 后续规则变更通过 verification-policy-service 创建更高版本。
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export const VERIFICATION_POLICY_SEED_VERSION = 1;

export const VERIFICATION_POLICY_SEED_TITLE = "校园认证规则";

export const VERIFICATION_POLICY_SEED_INSTRUCTIONS = [
  "【文档状态说明】本文档为校园认证规则的工程/产品治理基线文本，",
  "正式公开运营前将经过合规审查并以新版本发布，历史版本可追溯。",
  "",
  "1. 认证材料：请上传能证明你在校学生身份的学生证/校园卡照片（需包含学校名称、",
  "   个人信息与注册/有效期信息）；平台仅采集学生证后四位数字用于人工核对，",
  "   不采集、不存储完整学号。",
  "2. 材料保护：认证材料仅平台授权审核人员可查看，访问行为会被记录；",
  "   审核出结果后，材料将在保留期届满后删除，认证结论本身保留。",
  "3. 审核结果：提交后平台会尽快完成人工审核，结果将通过站内通知告知。",
  "   认证未通过时，可完善材料后重新提交。",
  "4. 诚信要求：提交伪造、变造或他人证件将导致认证被拒绝或吊销，",
  "   并可能触发账号治理措施。",
].join("\n");

export function computeSeedPolicyContentHash(instructions: string): string {
  return createHash("sha256").update(instructions, "utf8").digest("hex");
}

/**
 * 为指定校区发布 v1 认证策略（幂等）：已存在 (campusId, v1) 时原样返回，
 * 不改写任何已发布字段。
 */
export async function seedPublishedVerificationPolicy(
  client: PrismaClient,
  campusId: string,
): Promise<{ created: boolean }> {
  const existing = await client.campusVerificationPolicy.findUnique({
    where: {
      campusId_version: {
        campusId,
        version: VERIFICATION_POLICY_SEED_VERSION,
      },
    },
    select: { id: true },
  });

  if (existing) {
    return { created: false };
  }

  await client.campusVerificationPolicy.create({
    data: {
      campusId,
      version: VERIFICATION_POLICY_SEED_VERSION,
      status: "PUBLISHED",
      title: VERIFICATION_POLICY_SEED_TITLE,
      instructions: VERIFICATION_POLICY_SEED_INSTRUCTIONS,
      contentHash: computeSeedPolicyContentHash(VERIFICATION_POLICY_SEED_INSTRUCTIONS),
      effectiveAt: new Date(),
      publishedAt: new Date(),
    },
  });

  return { created: true };
}
