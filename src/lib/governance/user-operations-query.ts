import type { Prisma, UserStatus, VerificationStatus } from "@prisma/client";

import {
  parseCanonicalCursorDate,
  parseCanonicalCursorJson,
} from "@/lib/governance/canonical-cursor";
import { deriveEffectiveVerification } from "@/lib/trust/trust-snapshot";
import { prisma } from "@/lib/prisma";

/**
 * Phase 7F：用户运营读模型（/governance/users 队列 + 详情）。
 *
 * 硬合同（指令冻结 + Final Repair 1 FR01/FR02 修订）：
 * - 授权模型 = GLOBAL user.suspend ONLY（页面入口 resolver 已挡；本读模型
 *   只服务授权后的呈现，filter 只能缩小结果，不能扩大授权范围）；
 * - 队列 DTO 最小化：绝不携带 full email / studentId / 私有认证证据 /
 *   User.role authority / creditScore（不作为治理信号）/ internal notes；
 * - FR01：有效认证 = canonical truth（deriveEffectiveVerification SSOT，
 *   Phase 6B trust contract）——User.verificationStatus
 *   （LEGACY_VERIFICATION_PROJECTION = NON_AUTHORITATIVE_FOR_TRUST）结构性
 *   不进入 select/DTO/filter；EFFECTIVE_VERIFIED = canonical
 *   UserVerification.status == VERIFIED ∧ 绑定 membership.status == ACTIVE；
 * - FR02：RiskState 绝不进入本读模型（user.suspend ≠ enforcement.read
 *   ≠ audit.read 的能力分离）——canonical 风险读面在
 *   /governance/enforcement/targets/[userId]，本页仅提供链接；
 * - 排序 createdAt DESC, id DESC；bounded keyset（default 25 / max 50）；
 * - 存在性反 oracle：deleted / erased 用户从队列结构性排除，详情 Stage A
 *   判定 missing/deleted/erased 统一 notFound（互不可区分，不泄漏
 *   ACCOUNT_ERASED / ACCOUNT_DELETED / target privileged state）；
 * - cursor 为 canonical 纪律（canonical-cursor.ts，FR03）。
 */

export const USER_QUEUE_DEFAULT_PAGE_SIZE = 25;
export const USER_QUEUE_MAX_PAGE_SIZE = 50;

export type UserQueueItemDto = {
  userId: string;
  displayName: string;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
  /** ACTIVE membership 的校区名列表（展示用；非授权依据） */
  activeCampusNames: string[];
  /**
   * 有效认证状态（FR01：canonical truth，含绑定 membership ACTIVE 求交；
 * 绝非 User.verificationStatus legacy 投影）
   */
  effectiveVerificationStatus: VerificationStatus;
};

export type UserQueuePage = {
  items: UserQueueItemDto[];
  nextCursor: string | null;
};

export type UserQueueFilters = {
  status?: UserStatus;
  verificationStatus?: VerificationStatus;
  campusId?: string;
};

export type UserCursor = { createdAt: Date; id: string };

export function encodeUserCursor(cursor: UserCursor): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
  ).toString("base64url");
}

export function decodeUserCursor(raw: string): UserCursor | null {
  const payload = parseCanonicalCursorJson(raw, ["createdAt", "id"]);
  if (!payload) {
    return null;
  }
  const createdAt = parseCanonicalCursorDate(payload.createdAt);
  if (!createdAt || payload.id.length === 0) {
    return null;
  }
  const cursor: UserCursor = { createdAt, id: payload.id };
  // canonical 外层编码 + canonical JSON 键序的最终权威（FR03 C09/C10）
  if (encodeUserCursor(cursor) !== raw) {
    return null;
  }
  return cursor;
}

/** keyset 条件（DESC 全 tuple：createdAt < ∨ (=∧ id <)）。 */
function userKeysetCondition(cursor: UserCursor): Prisma.UserWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: { equals: cursor.createdAt }, id: { lt: cursor.id } },
    ],
  };
}

/**
 * FR01：有效认证 filter 的 canonical relation 谓词。
 * - VERIFIED = canonical 认证 VERIFIED ∧ 绑定 membership ACTIVE；
 * - UNVERIFIED = 上式取反（含 canonical 认证缺失 / 非 VERIFIED / 绑定
 *   membership 非 ACTIVE 三族——绝不静默实现为 legacy 投影判等）；
 * - 其余值 = canonical status 展示语义（不含 membership 求交）。
 */
function effectiveVerificationFilterCondition(
  verificationStatus: VerificationStatus,
): Prisma.UserWhereInput {
  const effectiveVerified: Prisma.UserWhereInput["verification"] = {
    is: { status: "VERIFIED", membership: { is: { status: "ACTIVE" } } },
  };
  switch (verificationStatus) {
    case "VERIFIED":
      return { verification: effectiveVerified };
    case "UNVERIFIED":
      return { NOT: { verification: effectiveVerified } };
    default:
      return { verification: { is: { status: verificationStatus } } };
  }
}

const queueUserSelect = {
  id: true,
  name: true,
  status: true,
  createdAt: true,
  lastLoginAt: true,
  // FR01：canonical 认证 + 绑定 membership status（推导 effective）；
  // User.verificationStatus / creditScore / email / studentId 结构性不在
  // select 内（NON_AUTHORITATIVE_FOR_TRUST + DTO 最小化合同）
  verification: {
    select: { status: true, membership: { select: { status: true } } },
  },
  memberships: {
    where: { status: "ACTIVE" },
    select: { campus: { select: { name: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.UserSelect;

export async function loadUserOperationsQueue(input: {
  cursor?: UserCursor;
  limit: number;
  filters?: UserQueueFilters;
}): Promise<UserQueuePage> {
  const filters = input.filters ?? {};
  const andConditions: Prisma.UserWhereInput[] = [
    // 存在性反 oracle：deleted / erased 用户不进入运营队列
    { deletedAt: null, erasedAt: null },
  ];

  // filters 只能缩小结果（AND 合取），不能扩大授权范围
  if (filters.status) {
    andConditions.push({ status: filters.status });
  }
  if (filters.verificationStatus) {
    andConditions.push(effectiveVerificationFilterCondition(filters.verificationStatus));
  }
  if (filters.campusId) {
    andConditions.push({ memberships: { some: { campusId: filters.campusId, status: "ACTIVE" } } });
  }
  if (input.cursor) {
    andConditions.push(userKeysetCondition(input.cursor));
  }

  const rows = await prisma.user.findMany({
    where: { AND: andConditions },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    select: queueUserSelect,
  });

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;

  const items = pageRows.map((row) => ({
    userId: row.id,
    displayName: row.name,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    activeCampusNames: row.memberships.map((membership) => membership.campus.name),
    effectiveVerificationStatus: deriveEffectiveVerification(row.verification),
  }));

  const last = pageRows[pageRows.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeUserCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}

// ── 详情（两阶段读：最小锚点 → 存在性/隐私规则 → 安全水合）──────────────────

/** campus 过滤下拉选项（GLOBAL-only 面：全部 active 校区；仅展示便利）。 */
export async function listUserQueueCampuses(): Promise<Array<{ id: string; name: string }>> {
  return prisma.campus.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

/** 邮箱脱敏：local 保留首 2 字符（不足则 1 字符），域名原样。 */
export function maskEmail(email: string): string {
  const atIndex = email.lastIndexOf("@");
  if (atIndex <= 0) {
    return "***";
  }
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);
  const keep = local.length >= 2 ? 2 : 1;
  return `${local.slice(0, keep)}***${domain}`;
}

export type UserDetailDto = {
  userId: string;
  displayName: string;
  maskedEmail: string;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
  memberships: Array<{ campusName: string; status: string }>;
  /** 有效认证状态（FR01：canonical truth；非授权依据，亦非 legacy 投影） */
  effectiveVerificationStatus: VerificationStatus;
  // FR02：RiskState 绝不进入 user.suspend 读面——canonical 风险读面在
  // /governance/enforcement/targets/[userId]（其自守 enforcement.read）。
};

export type UserDetailResult = { ok: true; detail: UserDetailDto } | { ok: false };

/**
 * 用户详情（两阶段读）：
 *
 *   Stage A — 最小 target 锚点（id/status/deletedAt/erasedAt；不读 email /
 *   studentId / verification material / private notes）
 *   → missing / deleted / erased 统一 { ok:false }（调用方映射 notFound()，
 *   无存在性 oracle——不区分三种形态，不泄漏 ACCOUNT_ERASED /
 *   ACCOUNT_DELETED / target privileged state）
 *   → Stage B — 安全详情水合（maskedEmail / memberships / canonical 有效
 *   认证投影，FR02：无任何 RiskState 读取）。
 *
 * 不复制 EnforcementAction history（canonical 读面在
 * /governance/enforcement/targets/[userId]，本页仅提供链接）。
 */
export async function loadUserOperationsDetail(input: {
  userId: string;
}): Promise<UserDetailResult> {
  // ---- Stage A：最小 target 锚点 ----
  const anchor = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, deletedAt: true, erasedAt: true },
  });

  if (!anchor || anchor.deletedAt !== null || anchor.erasedAt !== null) {
    return { ok: false };
  }

  // ---- Stage B：安全详情水合 ----
  const row = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      name: true,
      email: true,
      status: true,
      createdAt: true,
      lastLoginAt: true,
      deletedAt: true,
      erasedAt: true,
      // FR01：canonical 认证 + 绑定 membership status（非 legacy 投影）
      verification: {
        select: { status: true, membership: { select: { status: true } } },
      },
      memberships: {
        select: { status: true, campus: { select: { name: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      // FR02：RiskState 结构性不在 select 内（user.suspend ≠ enforcement.read）；
      // studentIdLast4 / 私有认证证据 / role / creditScore 同样不在 select 内
    },
  });

  if (!row || row.deletedAt !== null || row.erasedAt !== null) {
    // Stage A 与 B 之间的极端竞态（并发删除/注销）：与 missing 同形
    return { ok: false };
  }

  return {
    ok: true,
    detail: {
      userId: row.id,
      displayName: row.name,
      maskedEmail: maskEmail(row.email),
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
      memberships: row.memberships.map((membership) => ({
        campusName: membership.campus.name,
        status: membership.status,
      })),
      effectiveVerificationStatus: deriveEffectiveVerification(row.verification),
    },
  };
}
