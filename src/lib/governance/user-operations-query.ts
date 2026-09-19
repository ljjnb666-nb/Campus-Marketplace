import type { Prisma, UserStatus, VerificationStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Phase 7F：用户运营读模型（/governance/users 队列 + 详情）。
 *
 * 硬合同（指令冻结）：
 * - 授权模型 = GLOBAL user.suspend ONLY（页面入口 resolver 已挡；本读模型
 *   只服务授权后的呈现，filter 只能缩小结果，不能扩大授权范围）；
 * - 队列 DTO 最小化：绝不携带 full email / studentId / 私有认证证据 /
 *   User.role authority / raw verificationStatus authority / creditScore
 *   （不作为治理信号）/ internal notes——仅 id / safe displayName /
 *   account status / createdAt / lastLoginAt / active campus summary /
 *   effective verification summary；
 * - 排序 createdAt DESC, id DESC；bounded keyset（default 25 / max 50）；
 * - 存在性反 oracle：deleted / erased 用户从队列结构性排除，详情 Stage A
 *   判定 missing/deleted/erased 统一 notFound（互不可区分，不泄漏
 *   ACCOUNT_ERASED / ACCOUNT_DELETED / target privileged state）；
 * - 详情两阶段读：Stage A 最小 target 锚点（id/status/deletedAt/erasedAt，
 *   不读 email / studentId / verification material / private notes）→
 *   Stage B 安全详情水合（maskedEmail / memberships / effective
 *   verification summary / risk-state summary）；不复制 EnforcementAction
 *   history，仅提供 canonical link /governance/enforcement/targets/[userId]。
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
  /** 有效认证状态投影（展示用；非授权依据） */
  verificationStatus: VerificationStatus;
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
  let payload: unknown;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const { createdAt, id } = payload as Record<string, unknown>;
  if (typeof createdAt !== "string" || typeof id !== "string" || id.length === 0) {
    return null;
  }
  const createdAtDate = new Date(createdAt);
  if (Number.isNaN(createdAtDate.getTime())) {
    return null;
  }
  return { createdAt: createdAtDate, id };
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

const queueUserSelect = {
  id: true,
  name: true,
  status: true,
  createdAt: true,
  lastLoginAt: true,
  verificationStatus: true,
  deletedAt: true,
  erasedAt: true,
  memberships: {
    where: { status: "ACTIVE" },
    select: { campus: { select: { name: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
  // email / studentIdLast4 / role / creditScore / 任何私有认证证据
  // 结构性不在队列 select 内（DTO 最小化合同）
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
    andConditions.push({ verificationStatus: filters.verificationStatus });
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
    verificationStatus: row.verificationStatus,
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
  /** 有效认证状态投影（展示用；非授权依据） */
  verificationStatus: VerificationStatus;
  /** risk-state 摘要（每 scope 一行，current 状态；仅展示，非授权依据） */
  riskStates: Array<{ scopeKey: string; state: string; reasonCode: string | null }>;
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
 *   → Stage B — 安全详情水合（maskedEmail / memberships / verification
 *   投影 / RiskState current 摘要）。
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
      verificationStatus: true,
      deletedAt: true,
      erasedAt: true,
      memberships: {
        select: { status: true, campus: { select: { name: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      riskStates: {
        select: { scopeKey: true, state: true, reasonCode: true },
        orderBy: [{ scopeKey: "asc" }],
      },
      // studentIdLast4 / 私有认证证据 / role / creditScore 结构性不在 select 内
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
      verificationStatus: row.verificationStatus,
      riskStates: row.riskStates.map((risk) => ({
        scopeKey: risk.scopeKey,
        state: risk.state,
        reasonCode: risk.reasonCode,
      })),
    },
  };
}
