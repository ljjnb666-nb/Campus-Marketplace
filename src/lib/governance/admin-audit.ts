import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Phase 6A：管理审计日志写入服务（AdminAuditLog foundation，演进自 AdminLog）。
 *
 * 不变量：
 * - append-only：本模块只提供 create；全仓库不提供审计行的 update/delete 入口
 * - metadata 白名单：仅接受下方允许的键且值必须为原始类型；其余键一律丢弃。
 *   禁止进入审计的载荷（凭据/token/完整学号/私有对象键/私有 URL/原始认证材料）
 *   因白名单结构而在结构上不可表达，而非依赖调用方自觉
 * - 写失败不吞错：调用方（事务内）随业务一起回滚，保持"有写必有审计"
 */

/** 允许进入 metadata 的键白名单（机器可读、无敏感载荷） */
const ALLOWED_METADATA_KEYS = new Set([
  "decision",
  "policyId",
  "policyVersion",
  "assetCategory",
  "assetId",
  "grantedBy",
  "roleKey",
  "targetUserId",
  "reasonCode",
]);

function sanitizeMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | undefined {
  if (!metadata) {
    return undefined;
  }

  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) {
      continue;
    }
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export type RecordAdminAuditInput = {
  actorId: string;
  /** 机器可读动作（沿用既有命名风格，如 APPROVE_VERIFICATION / ROLE_ASSIGNED） */
  action: string;
  targetType: string;
  targetId: string;
  /** campus-scoped 操作的目标校区；全局操作留空 */
  campusId?: string | null;
  /** 机器可读结果；6A 全部写入路径为 SUCCESS */
  result?: string;
  /** 展示用备注（如审核意见）——由调用方保证不含敏感材料内容 */
  detail?: string | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * 写入一条管理审计。tx 提供时随调用方事务原子提交（敏感 mutation 用），
 * 否则独立写入（读路径审计用，如敏感资产访问）。
 */
export async function recordAdminAudit(
  input: RecordAdminAuditInput,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const data = {
    adminId: input.actorId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    detail: input.detail ?? null,
    campusId: input.campusId ?? null,
    result: input.result ?? "SUCCESS",
    metadata: sanitizeMetadata(input.metadata),
  };

  if (tx) {
    await tx.adminLog.create({ data });
    return;
  }

  await prisma.adminLog.create({ data });
}
