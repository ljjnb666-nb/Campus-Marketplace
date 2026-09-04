import { createHash } from "node:crypto";
import type { LegalDocument, LegalDocumentStatus, LegalDocumentType, Prisma } from "@prisma/client";

import { governanceError } from "@/lib/governance/domain-errors";
import { acquirePolicyLocks } from "@/lib/governance/governance-lock";
import { logger } from "@/lib/logger";
import { prisma, withTransaction } from "@/lib/prisma";

export type LegalDocumentSummary = Pick<
  LegalDocument,
  "id" | "type" | "version" | "status" | "title" | "effectiveAt" | "publishedAt" | "requiresAcceptance"
>;

export type LegalDocumentFull = LegalDocument;

/** canonical content 定义：文档 content 的 UTF-8 原文本身（不做任何归一化）。 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export const LEGAL_DOCUMENT_TYPES: LegalDocumentType[] = [
  "TERMS_OF_SERVICE",
  "PRIVACY_POLICY",
  "PLATFORM_RULES",
  "PROHIBITED_TRANSACTIONS",
];

/** 发布后不可变的字段集合（不变量的代码化表达，测试据此锁定）。 */
const IMMUTABLE_FIELDS = [
  "type",
  "version",
  "content",
  "contentHash",
  "effectiveAt",
  "requiresAcceptance",
] as const;

/**
 * 创建文档（DRAFT）。同 (type, version) 唯一约束兜底并发。
 */
export async function createLegalDocument(input: {
  type: LegalDocumentType;
  version: number;
  title: string;
  content: string;
  effectiveAt?: Date;
  requiresAcceptance?: boolean;
  createdById?: string;
}): Promise<LegalDocument> {
  return prisma.legalDocument.create({
    data: {
      type: input.type,
      version: input.version,
      title: input.title,
      content: input.content,
      contentHash: computeContentHash(input.content),
      effectiveAt: input.effectiveAt ?? new Date(),
      requiresAcceptance: input.requiresAcceptance ?? true,
      createdById: input.createdById,
    },
  });
}

/**
 * 发布文档：DRAFT → PUBLISHED。
 *
 * 发布即不可变。发布动作只允许改 status/publishedAt；任何对不可变字段的
 * 修改请求都会被拒绝（LEGAL_DOCUMENT_ALREADY_PUBLISHED）。
 *
 * Serialization：事务内先取该 type 的 policy advisory 锁（与
 * recordAcceptances 共享同一 serialization boundary）——"highestPublished
 * 检查 → PUBLISHED"窗口与并发 acceptance / 并发 publish 被互斥关闭，
 * 并发发布同 type 的 vN / vN+1 不会绕过版本顺序 invariant。
 */
export async function publishLegalDocument(documentId: string): Promise<LegalDocument> {
  return withTransaction(async (tx) => {
    const document = await tx.legalDocument.findUnique({ where: { id: documentId } });

    if (!document) {
      throw governanceError("LEGAL_DOCUMENT_NOT_FOUND");
    }

    if (document.status === "PUBLISHED") {
      // 幂等：重复发布同一文档原样返回，不产生第二个 published 版本
      return document;
    }

    if (document.status === "RETIRED") {
      throw governanceError("LEGAL_DOCUMENT_ALREADY_PUBLISHED", "已退役的文档不能重新发布");
    }

    await acquirePolicyLocks(tx, [document.type]);

    // 并发防护（锁内重读）：待发布版本号必须高于该类型全部已发布版本，
    // 避免倒序发布造成 current 漂移；(type, version) 唯一约束兜底。
    const highestPublished = await tx.legalDocument.findFirst({
      where: { type: document.type, status: { in: ["PUBLISHED", "RETIRED"] } },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    if (highestPublished && document.version <= highestPublished.version) {
      throw governanceError(
        "LEGAL_DOCUMENT_ALREADY_PUBLISHED",
        "存在不低于该版本的已发布文档，请使用更高版本号",
      );
    }

    const published = await tx.legalDocument.update({
      where: { id: document.id },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });

    logger.info("legal_document_published", "legal", {
      documentId: published.id,
      documentType: published.type,
      documentVersion: published.version,
      contentHash: published.contentHash,
    });

    return published;
  });
}

/**
 * DRAFT → RETIRED（放弃一个草稿）；PUBLISHED → RETIRED（下线，保留历史可查）。
 * retire 同样改变 current required 集合，必须持 policy 锁执行。
 */
export async function retireLegalDocument(documentId: string): Promise<LegalDocument> {
  return withTransaction(async (tx) => {
    const document = await tx.legalDocument.findUnique({
      where: { id: documentId },
      select: { type: true },
    });

    if (!document) {
      throw governanceError("LEGAL_DOCUMENT_NOT_FOUND");
    }

    await acquirePolicyLocks(tx, [document.type]);

    return tx.legalDocument.update({
      where: { id: documentId },
      data: { status: "RETIRED" },
    });
  });
}

/**
 * 更新文档。仅 DRAFT 状态允许修改内容字段；PUBLISHED/RETIRED 一律拒绝。
 * 这是"发布即不可变"不变量的唯一修改入口。
 */
export async function updateDraftLegalDocument(
  documentId: string,
  input: Partial<Pick<LegalDocument, "title" | "content" | "effectiveAt" | "requiresAcceptance">>,
): Promise<LegalDocument> {
  return withTransaction(async (tx) => {
    const document = await tx.legalDocument.findUnique({ where: { id: documentId } });

    if (!document) {
      throw governanceError("LEGAL_DOCUMENT_NOT_FOUND");
    }

    if (document.status !== "DRAFT") {
      throw governanceError("LEGAL_DOCUMENT_ALREADY_PUBLISHED");
    }

    if (document.publishedAt) {
      throw governanceError("LEGAL_DOCUMENT_ALREADY_PUBLISHED");
    }

    const data: Record<string, unknown> = {};
    for (const field of IMMUTABLE_FIELDS) {
      if (field === "effectiveAt" && input.effectiveAt) {
        data.effectiveAt = input.effectiveAt;
      }
      if (field === "requiresAcceptance" && typeof input.requiresAcceptance === "boolean") {
        data.requiresAcceptance = input.requiresAcceptance;
      }
    }
    if (input.title !== undefined) {
      data.title = input.title;
    }
    if (input.content !== undefined) {
      data.content = input.content;
      // content 变更必须同步 contentHash，二者永不脱钩
      data.contentHash = computeContentHash(input.content);
    }

    return tx.legalDocument.update({ where: { id: documentId }, data });
  });
}

/** 公开读取：当前生效版本（PUBLISHED 且 effectiveAt <= now，不过滤 requiresAcceptance）。 */
export async function getPublishedDocumentByType(
  type: LegalDocumentType,
): Promise<LegalDocumentFull | null> {
  return getCurrentPublishedDocument(type, new Date());
}

/** 指定版本的公开读取；未发布（DRAFT）一律不可见。 */
export async function getPublicDocument(
  type: LegalDocumentType,
  version?: number,
): Promise<LegalDocumentFull | null> {
  if (version === undefined) {
    return getPublishedDocumentByType(type);
  }

  const document = await prisma.legalDocument.findUnique({
    where: { type_version: { type, version } },
  });

  if (!document || document.status === "DRAFT") {
    return null;
  }

  return document;
}

/** 某类型的全部非草稿版本（历史查看），旧版本在前。 */
export async function listPublicVersions(
  type: LegalDocumentType,
): Promise<LegalDocumentSummary[]> {
  return prisma.legalDocument.findMany({
    where: { type, status: { not: "DRAFT" } },
    orderBy: { version: "asc" },
    select: {
      id: true,
      type: true,
      version: true,
      status: true,
      title: true,
      effectiveAt: true,
      publishedAt: true,
      requiresAcceptance: true,
    },
  });
}

/**
 * 【概念拆分 REPAIR】current 解析有两个明确不同的概念：
 *
 * 1. getCurrentPublishedDocument —— 该类型"当前公开生效文档"：
 *    PUBLISHED + effectiveAt <= now + version 最高。不过滤 requiresAcceptance，
 *    供公开页面/公开 API 展示（未来存在 requiresAcceptance=false 的纯展示
 *    文档时也必须可见）。
 * 2. getCurrentRequiredDocument —— 该类型"当前 required 同意政策"：
 *    在 1 的条件上再过滤 requiresAcceptance = true。仅 policy engine 使用。
 *
 * 两者排序显式确定性，绝不依赖数据库返回顺序。tx 变体供 recordAcceptances
 * 在锁内的事务上一致的解析（READ COMMITTED 下锁 + 同事务读 = 线性化）。
 */
export async function getCurrentPublishedDocument(
  type: LegalDocumentType,
  now: Date,
  tx?: Prisma.TransactionClient,
): Promise<LegalDocumentFull | null> {
  const where = {
    type,
    status: "PUBLISHED" as const,
    effectiveAt: { lte: now },
  };

  // 扩展客户端与事务客户端的联合类型会触发 Prisma excessive stack depth
  // （见 notification-repository.ts 同注），因此 prisma / tx 两条路径显式分开。
  if (tx) {
    const rows = await tx.legalDocument.findMany({
      where,
      orderBy: [{ version: "desc" }, { id: "asc" }],
      take: 1,
    });

    return rows[0] ?? null;
  }

  const rows = await prisma.legalDocument.findMany({
    where,
    orderBy: [{ version: "desc" }, { id: "asc" }],
    take: 1,
  });

  return rows[0] ?? null;
}

export async function getCurrentRequiredDocument(
  type: LegalDocumentType,
  now: Date,
  tx?: Prisma.TransactionClient,
): Promise<LegalDocumentFull | null> {
  const where = {
    type,
    status: "PUBLISHED" as const,
    effectiveAt: { lte: now },
    requiresAcceptance: true,
  };

  if (tx) {
    const rows = await tx.legalDocument.findMany({
      where,
      orderBy: [{ version: "desc" }, { id: "asc" }],
      take: 1,
    });

    return rows[0] ?? null;
  }

  const rows = await prisma.legalDocument.findMany({
    where,
    orderBy: [{ version: "desc" }, { id: "asc" }],
    take: 1,
  });

  return rows[0] ?? null;
}

/**
 * @deprecated 兼容别名：语义为 required 解析。请改用
 * getCurrentRequiredDocument（policy engine）或 getCurrentPublishedDocument（公开展示）。
 */
export async function getCurrentDocument(
  type: LegalDocumentType,
  now: Date,
): Promise<LegalDocumentFull | null> {
  return getCurrentRequiredDocument(type, now);
}

export type LegalDocumentStatusValue = LegalDocumentStatus;
