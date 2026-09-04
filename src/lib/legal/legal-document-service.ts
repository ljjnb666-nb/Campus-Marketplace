import { createHash } from "node:crypto";
import type { LegalDocument, LegalDocumentStatus, LegalDocumentType } from "@prisma/client";

import { governanceError } from "@/lib/governance/domain-errors";
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
 * (type, version) 数据库唯一约束 + 事务内重读校验共同防并发发布。
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

    // 并发防护：唯一约束 (type, version) 已在数据库层兜底；事务内再校验
    // 待发布版本号确实高于该类型全部已发布版本，避免倒序发布造成 current 漂移。
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

/** DRAFT → RETIRED（放弃一个草稿）；PUBLISHED → RETIRED（下线，保留历史可查）。 */
export async function retireLegalDocument(documentId: string): Promise<LegalDocument> {
  return prisma.legalDocument.update({
    where: { id: documentId },
    data: { status: "RETIRED" },
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

/** 公开读取：当前生效版本（PUBLISHED 且 effectiveAt <= now）。 */
export async function getPublishedDocumentByType(
  type: LegalDocumentType,
): Promise<LegalDocumentFull | null> {
  return getCurrentDocument(type, new Date());
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
 * 当前生效版本解析（与 policy-service 共用的确定性核心）：
 * - 仅 PUBLISHED 且 effectiveAt <= now 参与解析
 * - 同一 type 取 version 最高者；排序显式确定性，绝不依赖数据库返回顺序
 * - 不存在 → null（该类型当前无生效政策）
 */
export async function getCurrentDocument(
  type: LegalDocumentType,
  now: Date,
): Promise<LegalDocumentFull | null> {
  const candidates = await prisma.legalDocument.findMany({
    where: {
      type,
      status: "PUBLISHED",
      effectiveAt: { lte: now },
      requiresAcceptance: true,
    },
    orderBy: [{ version: "desc" }, { id: "asc" }],
    take: 1,
  });

  return candidates[0] ?? null;
}

export type LegalDocumentStatusValue = LegalDocumentStatus;
