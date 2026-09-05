import type { LegalDocumentType, PolicyAcceptance } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  listPublicVersions,
  getPublicDocument,
  type LegalDocumentSummary,
} from "@/lib/legal/legal-document-service";
import { getRequiredPolicies, getUserAcceptanceStatus } from "@/lib/legal/policy-service";

/** 页面层（app → repositories）读取法务/同意数据的薄封装。 */

export type LegalDocumentView = {
  type: LegalDocumentType;
  slug: LegalDocumentSlug;
  version: number;
  title: string;
  content: string;
  contentHash: string;
  effectiveAt: Date;
  status: "PUBLISHED" | "RETIRED";
};

export const LEGAL_DOCUMENT_SLUGS = {
  TERMS_OF_SERVICE: "terms",
  PRIVACY_POLICY: "privacy",
  PLATFORM_RULES: "rules",
  PROHIBITED_TRANSACTIONS: "prohibited",
} as const;

export type LegalDocumentSlug =
  (typeof LEGAL_DOCUMENT_SLUGS)[keyof typeof LEGAL_DOCUMENT_SLUGS];

export const LEGAL_SLUG_TO_TYPE: Record<LegalDocumentSlug, LegalDocumentType> = {
  terms: "TERMS_OF_SERVICE",
  privacy: "PRIVACY_POLICY",
  rules: "PLATFORM_RULES",
  prohibited: "PROHIBITED_TRANSACTIONS",
};

export function isLegalDocumentSlug(value: string): value is LegalDocumentSlug {
  return value in LEGAL_SLUG_TO_TYPE;
}

/** 当前生效文档（不传 version）或指定历史版本。DRAFT 不可见。 */
export async function getLegalDocumentView(
  slug: LegalDocumentSlug,
  version?: number,
): Promise<LegalDocumentView | null> {
  const document = await getPublicDocument(LEGAL_SLUG_TO_TYPE[slug], version);

  if (!document) {
    return null;
  }

  return {
    type: document.type,
    slug,
    version: document.version,
    title: document.title,
    content: document.content,
    contentHash: document.contentHash,
    effectiveAt: document.effectiveAt,
    status: document.status === "RETIRED" ? "RETIRED" : "PUBLISHED",
  };
}

/** 历史版本列表（当前生效在前）。 */
export async function getLegalDocumentVersions(
  slug: LegalDocumentSlug,
): Promise<LegalDocumentSummary[]> {
  return listPublicVersions(LEGAL_SLUG_TO_TYPE[slug]);
}

/** 四个类型的当前生效文档（legal 首页 / 注册页 / 同意页共用）。 */
export async function getCurrentLegalDocuments(): Promise<
  Array<{ type: LegalDocumentType; slug: LegalDocumentSlug; id: string; version: number; title: string; effectiveAt: Date }>
> {
  const required = await getRequiredPolicies();

  return required.map((document) => ({
    type: document.type,
    slug: LEGAL_DOCUMENT_SLUGS[document.type],
    id: document.id,
    version: document.version,
    title: document.title,
    effectiveAt: document.effectiveAt,
  }));
}

/** 用户同意历史（隐私设置页）。 */
export async function getUserAcceptanceHistory(userId: string): Promise<PolicyAcceptance[]> {
  return prisma.policyAcceptance.findMany({
    where: { userId },
    orderBy: { acceptedAt: "desc" },
  });
}

/** 同意页/隐私设置页：required + 用户当前满足状态。 */
export async function getUserPolicyStatus(userId: string) {
  return getUserAcceptanceStatus(userId);
}
