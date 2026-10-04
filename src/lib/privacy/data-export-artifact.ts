import type { Prisma, DataExportArtifact, DataExportArtifactStatus } from "@prisma/client";

import { governanceError } from "@/lib/governance/domain-errors";
import { withTransaction } from "@/lib/prisma";


/**
 * Phase 9C-03：DataExportArtifact 状态机（显式 transition helper，
 * 禁止任意赋值跳状态——与 transitionPrivacyRequest 同一 SSOT 惯例）。
 *
 *   WRITING → READY           （Step B finalization：PUT 后原子 READY）
 *   WRITING → PENDING_DELETE  （请求收敛失败 / too-large / 注销 / 损坏收敛）
 *   READY → PENDING_DELETE    （到期 / 注销）
 *   PENDING_DELETE → DELETED   （cleanup 物理删除成功后唯一推进者）
 *
 * PENDING_DELETE → DELETED 只能由 cleanup 在 DeleteObject（幂等）之后以
 * 条件更新推进——「DeleteObject success + DB commit fail → retry」与
 * 「two cleanup workers → one logical DELETED transition」都由
 * PENDING_DELETE 状态谓词 + 条件 UPDATE 收敛（§28）。
 */
const ALLOWED_ARTIFACT_TRANSITIONS: Record<DataExportArtifactStatus, DataExportArtifactStatus[]> = {
  WRITING: ["READY", "PENDING_DELETE"],
  READY: ["PENDING_DELETE"],
  PENDING_DELETE: ["DELETED"],
  DELETED: [],
};

export function canTransitionArtifact(
  from: DataExportArtifactStatus,
  to: DataExportArtifactStatus,
): boolean {
  return ALLOWED_ARTIFACT_TRANSITIONS[from].includes(to);
}

export type ArtifactFinalizeData = {
  sizeBytes: number;
  sha256: string;
  expiresAt: Date;
};

/** 显式状态迁移 helper（artifact 状态唯一合法写入口）。 */
export async function transitionDataExportArtifact(
  artifactId: string,
  to: DataExportArtifactStatus,
  options?: {
    tx?: Prisma.TransactionClient;
    finalize?: ArtifactFinalizeData;
  },
): Promise<DataExportArtifact> {
  const run = async (client: Prisma.TransactionClient) => {
    const current = await client.dataExportArtifact.findUnique({ where: { id: artifactId } });

    if (!current) {
      throw governanceError("PRIVACY_REQUEST_NOT_FOUND", "导出 artifact 不存在");
    }

    if (!canTransitionArtifact(current.status, to)) {
      throw governanceError("PRIVACY_REQUEST_INVALID_TRANSITION", "导出 artifact 状态不允许此迁移");
    }

    const data: Prisma.DataExportArtifactUpdateInput = { status: to };

    if (options?.finalize) {
      data.sizeBytes = options.finalize.sizeBytes;
      data.sha256 = options.finalize.sha256;
      data.expiresAt = options.finalize.expiresAt;
    }

    if (to === "DELETED") {
      data.deletedAt = new Date();
    }

    return client.dataExportArtifact.update({ where: { id: artifactId }, data });
  };

  return options?.tx ? run(options.tx) : withTransaction(run);
}

/**
 * 条件 DELETED 推进（cleanup 专用）：PENDING_DELETE 谓词条件更新——
 * 两个并发 cleanup worker 恰好一个完成逻辑转移（另一者 0 rows = NOOP），
 * DeleteObject 本身幂等，crash 后重试安全（§28 exactly-once 语义）。
 */
export async function markArtifactDeletedIfPendingDelete(
  client: Prisma.TransactionClient,
  artifactId: string,
  now: Date,
): Promise<boolean> {
  const result = await client.dataExportArtifact.updateMany({
    where: { id: artifactId, status: "PENDING_DELETE" },
    data: { status: "DELETED", deletedAt: now },
  });
  return result.count > 0;
}

/** 按 requestId 读取 artifact（仅事务客户端——扩展客户端与事务客户端的
 * 联合类型会触发 Prisma excessive stack depth，loadAuthorizationContext
 * 同注；非事务路径直接使用 prisma.dataExportArtifact）。 */
export async function findArtifactByRequestIdTx(
  tx: Prisma.TransactionClient,
  requestId: string,
): Promise<DataExportArtifact | null> {
  return tx.dataExportArtifact.findUnique({ where: { requestId } });
}
