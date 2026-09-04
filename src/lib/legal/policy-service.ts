import type {
  LegalDocument,
  LegalDocumentType,
  PolicyAcceptance,
  PolicyAcceptanceSource,
  Prisma,
} from "@prisma/client";

import { governanceError } from "@/lib/governance/domain-errors";
import { acquirePolicyLocks } from "@/lib/governance/governance-lock";
import { logger } from "@/lib/logger";
import { prisma, withTransaction } from "@/lib/prisma";
import {
  getCurrentRequiredDocument,
  LEGAL_DOCUMENT_TYPES,
} from "@/lib/legal/legal-document-service";

export type RequiredPolicySummary = {
  id: string;
  type: LegalDocumentType;
  version: number;
  title: string;
  contentHash: string;
  effectiveAt: Date;
};

export type AcceptanceRecord = PolicyAcceptance;

export type UserAcceptanceStatusResult = {
  /** true = 当前 required 集合已全部接受（或当前没有 required 政策） */
  compliant: boolean;
  /** 当前生效的 required 集合（确定性解析结果） */
  required: RequiredPolicySummary[];
  /** 未满足的文档：MISSING（从未接受）或 OUTDATED（接受的是旧版本） */
  pending: Array<RequiredPolicySummary & { state: "MISSING" | "OUTDATED"; acceptedVersion: number | null }>;
};

/**
 * 当前 required 政策集合：四个逻辑类型逐一做确定性 current 解析。
 * 某类型没有已发布且生效的文档时，不进入 required 集合（该类型暂无约束）。
 *
 * @param tx 可选事务客户端：在受 policy 锁保护的事务内做线性化解析时传入
 *         （与写路径同一事务 = 同一 serialization window）。
 */
export async function getRequiredPolicies(
  now: Date = new Date(),
  tx?: Prisma.TransactionClient,
): Promise<RequiredPolicySummary[]> {
  const resolved = await Promise.all(
    LEGAL_DOCUMENT_TYPES.map((type) => getCurrentRequiredDocument(type, now, tx)),
  );

  return resolved
    .filter((document): document is LegalDocument => document !== null)
    .map((document) => ({
      id: document.id,
      type: document.type,
      version: document.version,
      title: document.title,
      contentHash: document.contentHash,
      effectiveAt: document.effectiveAt,
    }))
    // 稳定输出顺序（按类型枚举序），杜绝依赖数据库返回顺序
    .sort(
      (a, b) =>
        LEGAL_DOCUMENT_TYPES.indexOf(a.type) - LEGAL_DOCUMENT_TYPES.indexOf(b.type),
    );
}

/** 供锁序文档引用的类型清单（canonical 定义在 legal-document-service）。 */
export { LEGAL_DOCUMENT_TYPES };

/**
 * 用户对当前 required 集合的接受状态。
 *
 * 判定按 documentType 语义匹配：用户在该类型上最近一次接受的版本
 * - 不存在 → MISSING（legacy/从未同意）
 * - 是当前版本（documentId 确认）→ ACCEPTED_CURRENT
 * - 是旧版本 → OUTDATED（旧同意不延续到新版本，必须重新确认）
 */
export async function getUserAcceptanceStatus(
  userId: string,
  now: Date = new Date(),
  tx?: Prisma.TransactionClient,
): Promise<UserAcceptanceStatusResult> {
  const required = await getRequiredPolicies(now, tx);

  if (required.length === 0) {
    return { compliant: true, required: [], pending: [] };
  }

  const acceptances = tx
    ? await tx.policyAcceptance.findMany({
        where: { userId, documentType: { in: required.map((document) => document.type) } },
        orderBy: [{ acceptedAt: "desc" }, { id: "desc" }],
      })
    : await prisma.policyAcceptance.findMany({
        where: { userId, documentType: { in: required.map((document) => document.type) } },
        orderBy: [{ acceptedAt: "desc" }, { id: "desc" }],
      });

  return buildAcceptanceStatus(userId, required, acceptances);
}

function buildAcceptanceStatus(
  _userId: string,
  required: RequiredPolicySummary[],
  acceptances: Array<Pick<PolicyAcceptance, "documentType" | "documentId" | "documentVersion">>,
): UserAcceptanceStatusResult {
  const latestByType = new Map<string, (typeof acceptances)[number]>();
  for (const acceptance of acceptances) {
    if (!latestByType.has(acceptance.documentType)) {
      latestByType.set(acceptance.documentType, acceptance);
    }
  }

  const pending = required
    .filter((document) => {
      const latest = latestByType.get(document.type);
      return !latest || latest.documentId !== document.id;
    })
    .map((document) => {
      const latest = latestByType.get(document.type);

      if (!latest) {
        return {
          ...document,
          state: "MISSING" as const,
          acceptedVersion: null,
        };
      }

      return {
        ...document,
        state: "OUTDATED" as const,
        acceptedVersion: latest.documentVersion,
      };
    });

  return {
    compliant: pending.length === 0,
    required,
    pending,
  };
}

/**
 * 中央 consent gate 校验：不满足则抛 LEGAL_ACCEPTANCE_REQUIRED。
 * 所有需要账户身份的业务 mutation 必须先经过这里（requireUser 中央卡点）。
 */
export async function assertRequiredPoliciesAccepted(
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const status = await getUserAcceptanceStatus(userId, now);

  if (!status.compliant) {
    logger.warn("reconsent_required", "legal", {
      userId,
      pendingTypes: status.pending.map((document) => document.type),
    });
    throw governanceError("LEGAL_ACCEPTANCE_REQUIRED");
  }
}

/** 测试 seam：在 policy 锁 + 解析 + 校验全部完成后、证据写入前触发的受控暂停点。 */
export type AcceptanceRacePoint = (tx: Prisma.TransactionClient) => Promise<void>;

/**
 * 记录同意证据（幂等）。
 *
 * Serialization contract（Phase 5 REPAIR）：
 * "resolve current → resolve user pending → validate → insert" 全部在
 * 同一个持有 policy advisory 锁的事务内完成（锁按 LEGAL_DOCUMENT_TYPES
 * 固定顺序获取，publish/retire 用同一锁命名空间）。因此并发
 * publishLegalDocument 只能线性化在本次 acceptance 之前（stale 提交被
 * NOT_CURRENT / VERSION_CHANGED 拒绝）或之后（本次为成功的 v1 同意，
 * publish 随后发生、用户随即 OUTDATED）——不存在"v2 已发布而 v1 同意
 * 仍以 latest 成功提交"的交错。
 *
 * fail-closed 契约：
 * - 提交的每个 documentId 都必须是"当前 required 集合"成员（缺、旧版本、
 *   杜撰 id 一律拒绝 → LEGAL_DOCUMENT_NOT_FOUND / LEGAL_DOCUMENT_NOT_CURRENT）；
 * - 提交集合必须覆盖用户当前全部 pending 文档；已接受当前版本的文档
 *   可以随集提交（幂等跳过）；
 * - (userId, documentId) 唯一约束 + 事务：并发双击最多产生一条证据。
 * - 证据固化 type/version/hash 三元组快照，审计自足。
 *
 * @param tx 可选事务客户端（注册流程与用户创建同事务时传入；
 *           注册事务同样先取 policy 锁，遵循同一 consistency contract）
 */
export async function recordAcceptances(input: {
  userId: string;
  documentIds: string[];
  source: PolicyAcceptanceSource;
  tx?: Prisma.TransactionClient;
  now?: Date;
  racePoint?: AcceptanceRacePoint;
}): Promise<{ created: number; skipped: number }> {
  const now = input.now ?? new Date();

  const run = async (tx: Prisma.TransactionClient): Promise<{ created: number; skipped: number }> => {
    // ---- serialization boundary：按固定顺序锁全部 policy types ----
    await acquirePolicyLocks(tx, LEGAL_DOCUMENT_TYPES);

    // ---- resolve + validate + write 全部在锁内同一事务 ----
    const required = await getRequiredPolicies(now, tx);
    const requiredById = new Map(required.map((document) => [document.id, document]));

    const requestedIds = [...new Set(input.documentIds)];

    for (const documentId of requestedIds) {
      const document = requiredById.get(documentId);

      if (!document) {
        // 不在当前 required 集合内：可能是已退役/未发布/未来生效/杜撰的 id
        const exists = await tx.legalDocument.findUnique({ where: { id: documentId } });

        if (!exists || exists.status !== "PUBLISHED") {
          throw governanceError("LEGAL_DOCUMENT_NOT_FOUND");
        }

        throw governanceError("LEGAL_DOCUMENT_NOT_CURRENT");
      }
    }

    const status = await buildAcceptanceStatus(
      input.userId,
      required,
      await tx.policyAcceptance.findMany({
        where: {
          userId: input.userId,
          documentType: { in: required.map((document) => document.type) },
        },
        orderBy: [{ acceptedAt: "desc" }, { id: "desc" }],
      }),
    );

    // 必须覆盖全部 pending（旧版本同意不能绕过：只补缺口，不留欠账）
    for (const pending of status.pending) {
      if (!requestedIds.includes(pending.id)) {
        throw governanceError("LEGAL_DOCUMENT_VERSION_CHANGED");
      }
    }

    // 测试 seam：锁 + 解析 + 校验之后、写之前（并发 publish 在此点发起会被
    // policy 锁阻塞直到本事务结束——用于 publish/acceptance 线性化的真实
    // PG 竞态测试）。生产路径不传该参数。
    if (input.racePoint) {
      await input.racePoint(tx);
    }

    let created = 0;
    let skipped = 0;

    for (const documentId of requestedIds) {
      const document = requiredById.get(documentId);

      if (!document) {
        continue;
      }

      const existing = await tx.policyAcceptance.findUnique({
        where: { userId_documentId: { userId: input.userId, documentId } },
        select: { id: true, documentVersion: true },
      });

      if (existing) {
        if (existing.documentVersion !== document.version) {
          // 不可能路径（证据不可改写），防御性兜底：绝不覆盖旧证据
          throw governanceError("PRIVACY_REQUEST_INVALID_TRANSITION");
        }

        skipped += 1;
        continue;
      }

      try {
        await tx.policyAcceptance.create({
          data: {
            userId: input.userId,
            documentId,
            documentType: document.type,
            documentVersion: document.version,
            documentHash: document.contentHash,
            source: input.source,
            acceptedAt: now,
          },
        });
        created += 1;

        logger.info("policy_acceptance_created", "legal", {
          userId: input.userId,
          documentId,
          documentType: document.type,
          documentVersion: document.version,
          source: input.source,
        });
      } catch (error) {
        // 并发双击：唯一约束冲突视为幂等成功（另一请求已创建同一证据）
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: string }).code === "P2002"
        ) {
          skipped += 1;
          continue;
        }

        throw error;
      }
    }

    return { created, skipped };
  };

  return input.tx ? run(input.tx) : withTransaction(run);
}

/** 用户的全部接受历史（隐私设置页 / 导出使用）。 */
export async function listUserAcceptances(userId: string): Promise<AcceptanceRecord[]> {
  return prisma.policyAcceptance.findMany({
    where: { userId },
    orderBy: { acceptedAt: "desc" },
  });
}

/**
 * 注册流程专用：在给定事务内先取 policy 锁，再校验并写入 SIGNUP 同意证据
 * （与用户创建同事务提交，且遵循同一 policy consistency contract）。
 */
export async function recordSignupAcceptances(
  tx: Prisma.TransactionClient,
  userId: string,
  documentIds: string[],
  now: Date = new Date(),
): Promise<{ created: number; skipped: number }> {
  return recordAcceptances({
    userId,
    documentIds,
    source: "SIGNUP",
    tx,
    now,
  });
}
