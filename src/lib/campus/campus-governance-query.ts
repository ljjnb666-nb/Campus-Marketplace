import type { CampusVerificationPolicy, Prisma } from "@prisma/client";

import {
  parseCanonicalCursorDate,
  parseCanonicalCursorJson,
} from "@/lib/governance/canonical-cursor";
import { prisma } from "@/lib/prisma";

/**
 * Phase 7H：校区治理授权读模型（/governance/campuses，READ-ONLY）。
 *
 * 调用方（page）已通过 requireCampusManager 门（GLOBAL campus.manage）——
 * 本模块不再自行判权，但保持治理 read discipline（Planning §19/§20 冻结）：
 * - 列表（§19）：仅 campus metadata + 轻量 summary counts；结构性不读取
 *   verification evidence / user email / private notes / risk states /
 *   support descriptions；
 * - 详情两阶段（§20）：Stage A 仅校验 id 存在（最小锚点）→ 授权（page 层
 *   requireCampusManager，notFound 防枚举）→ Stage B 才读取 campus metadata
 *   / membership summary / policy versions。GLOBAL-only 也不养成 sensitive
 *   preload；
 * - 有界（§60）：列表 default 25 / max 50，一次有界查询；summary counts 用
 *   两条 GROUP BY 聚合（零 N+1，绝不 load all rows 后 JS 计数）。
 */

export const CAMPUS_LIST_DEFAULT_PAGE_SIZE = 25;
export const CAMPUS_LIST_MAX_PAGE_SIZE = 50;

export type GovernanceCampusListItem = {
  id: string;
  name: string;
  slug: string;
  schoolName: string;
  district: string | null;
  isActive: boolean;
  createdAt: string;
  activeMembershipCount: number;
  pendingVerificationCount: number;
};

// ── Final Review Repair 1（FR04）：bounded keyset pagination ─────────────────
// 排序冻结：createdAt ASC, id ASC；cursor = canonical base64url(JSON)
// { createdAt: canonical ISO, id }，沿用 canonical-cursor SSOT 纪律
// （raw 白名单 / exact JSON keys / canonical ISO / non-empty id /
// re-encode equality）；malformed cursor 一律 fail closed，绝不静默回第一页。

export type GovernanceCampusCursor = { createdAt: Date; id: string };

/** 由实际返回的最后一条生成下一页 cursor（base64url(JSON)）。 */
export function encodeGovernanceCampusCursor(cursor: GovernanceCampusCursor): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    }),
  ).toString("base64url");
}

/** 解码客户端回传 cursor；任何解析/校验失败返回 null（调用方 fail closed）。 */
export function decodeGovernanceCampusCursor(raw: string): GovernanceCampusCursor | null {
  const payload = parseCanonicalCursorJson(raw, ["createdAt", "id"]);
  if (!payload) {
    return null;
  }
  const createdAt = parseCanonicalCursorDate(payload.createdAt);
  if (!createdAt || payload.id.length === 0) {
    return null;
  }
  const cursor: GovernanceCampusCursor = { createdAt, id: payload.id };
  if (encodeGovernanceCampusCursor(cursor) !== raw) {
    return null;
  }
  return cursor;
}

/**
 * campus 列表 + 轻量 summary（§19）。keyset 条件（ASC 全 tuple：
 * createdAt > ∨ (=∧id >)）；take limit+1 探测 hasMore。三条查询并行：
 * campus 有界页、ACTIVE membership 按 campus 聚合、PENDING verification
 * 按 campus 聚合（raw GROUP BY 一次聚合，绝不逐 campus N+1）。
 */
export async function listGovernanceCampuses(input: {
  limit: number;
  cursor?: GovernanceCampusCursor;
}): Promise<{
  items: GovernanceCampusListItem[];
  nextCursor: string | null;
}> {
  const limit = Math.min(Math.max(1, input.limit), CAMPUS_LIST_MAX_PAGE_SIZE);

  const keyset: Prisma.CampusWhereInput = input.cursor
    ? {
        OR: [
          { createdAt: { gt: input.cursor.createdAt } },
          {
            createdAt: { equals: input.cursor.createdAt },
            id: { gt: input.cursor.id },
          },
        ],
      }
    : {};

  const [rows, membershipCounts, verificationCounts] = await Promise.all([
    prisma.campus.findMany({
      where: keyset,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      select: {
        id: true,
        name: true,
        slug: true,
        schoolName: true,
        district: true,
        isActive: true,
        createdAt: true,
      },
    }),
    prisma.campusMembership.groupBy({
      by: ["campusId"],
      where: { status: "ACTIVE" },
      _count: { _all: true },
    }),
    prisma.$queryRaw<Array<{ campusId: string; pending: bigint }>>`
      SELECT m."campusId", COUNT(*) AS "pending"
      FROM "UserVerification" v
      JOIN "CampusMembership" m ON m."id" = v."membershipId"
      WHERE v."status" = 'PENDING'
      GROUP BY m."campusId"`,
  ]);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];

  const activeMembershipByCampus = new Map(
    membershipCounts.map((row) => [row.campusId, row._count._all]),
  );
  const pendingVerificationByCampus = new Map(
    verificationCounts.map((row) => [row.campusId, Number(row.pending)]),
  );

  return {
    items: pageRows.map((campus) => ({
    id: campus.id,
    name: campus.name,
    slug: campus.slug,
    schoolName: campus.schoolName,
    district: campus.district,
    isActive: campus.isActive,
    createdAt: campus.createdAt.toISOString(),
      activeMembershipCount: activeMembershipByCampus.get(campus.id) ?? 0,
      pendingVerificationCount: pendingVerificationByCampus.get(campus.id) ?? 0,
    })),
    nextCursor:
      hasMore && last
        ? encodeGovernanceCampusCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}

/**
 * Stage A：最小存在性锚点（仅 id）——不存在时调用方 notFound()（防枚举：
 * 响应形状与未授权一致）。
 */
export async function getGovernanceCampusExists(
  campusId: string,
): Promise<{ id: string } | null> {
  return prisma.campus.findUnique({
    where: { id: campusId },
    select: { id: true },
  });
}

export type GovernanceCampusPolicyVersion = {
  id: string;
  version: number;
  status: CampusVerificationPolicy["status"];
  title: string;
  effectiveAt: string;
  publishedAt: string | null;
  contentHash: string;
  createdAt: string;
  /** instructions 仅在 detail / edit 场景读取且仅 DRAFT 暴露（§29） */
  draftInstructions?: string;
};

export type GovernanceCampusDetail = {
  campus: {
    id: string;
    name: string;
    slug: string;
    schoolName: string;
    district: string | null;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
  };
  activeMembershipCount: number;
  pendingVerificationCount: number;
  policyVersions: GovernanceCampusPolicyVersion[];
};

/**
 * Stage B：campus metadata + membership summary counts + verification
 * policy 版本列表（§20/§29）。policy versions 不含 instructions 全文
 * （列表展示最小面）；publishedAt/createdAt/contentHash 按 §29 展示。
 */
export async function getGovernanceCampusDetail(
  campusId: string,
): Promise<GovernanceCampusDetail | null> {
  const [campus, activeMembershipCount, pendingVerificationCount, policyVersions] =
    await Promise.all([
      prisma.campus.findUnique({
        where: { id: campusId },
        select: {
          id: true,
          name: true,
          slug: true,
          schoolName: true,
          district: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.campusMembership.count({ where: { campusId, status: "ACTIVE" } }),
      prisma.userVerification.count({
        where: { membership: { campusId }, status: "PENDING" },
      }),
      prisma.campusVerificationPolicy.findMany({
        where: { campusId },
        orderBy: [{ version: "desc" }, { id: "asc" }],
        select: {
          id: true,
          version: true,
          status: true,
          title: true,
          instructions: true,
          effectiveAt: true,
          publishedAt: true,
          contentHash: true,
          createdAt: true,
        },
      }),
    ]);

  if (!campus) {
    return null;
  }

  return {
    campus: {
      id: campus.id,
      name: campus.name,
      slug: campus.slug,
      schoolName: campus.schoolName,
      district: campus.district,
      isActive: campus.isActive,
      createdAt: campus.createdAt.toISOString(),
      updatedAt: campus.updatedAt.toISOString(),
    },
    activeMembershipCount,
    pendingVerificationCount,
    policyVersions: policyVersions.map((policy) => ({
      id: policy.id,
      version: policy.version,
      status: policy.status,
      title: policy.title,
      effectiveAt: policy.effectiveAt.toISOString(),
      publishedAt: policy.publishedAt ? policy.publishedAt.toISOString() : null,
      contentHash: policy.contentHash,
      createdAt: policy.createdAt.toISOString(),
      ...(policy.status === "DRAFT" ? { draftInstructions: policy.instructions } : {}),
    })),
  };
}
