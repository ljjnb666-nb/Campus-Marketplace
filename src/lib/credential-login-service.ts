import type { Prisma } from "@prisma/client";

import { acquireGovernanceSubjectLock } from "@/lib/governance/governance-lock";
import { withTransaction } from "@/lib/prisma";

/**
 * RB-03 REVIEW FIX：CREDENTIAL_LOGIN_FINALIZATION_CONTRACT。
 *
 * Successful credential authentication may perform expensive password
 * verification outside the USER lock, but it MUST NOT finalize
 * authentication using a lifecycle state, password hash, identifier, or
 * identity snapshot that predates a concurrent account lifecycle
 * transition.
 *
 * 冻结流程（bcrypt 由调用方在本服务之外执行）：
 *   BEGIN TRANSACTION
 *   → [beforeLock seam（仅测试）]
 *   → USER governance subject lock（与 eraseAccount 同一 USER:<id> / 730501）
 *   → 锁内重读 fresh row（lifecycle + hash + email 字段）
 *   → fresh lifecycle：exists ∧ deletedAt = null ∧ erasedAt = null
 *     ∧ status ∈ { ACTIVE, SUSPENDED }（Phase 6C-2：SUSPENDED 允许重建
 *     身份会话；业务边界仍由 server-auth 中央 resolver ACTIVE-only 强制）
 *   → fresh.passwordHash === candidate.passwordHash（bcrypt 结果只授权
 *     它实际验证过的那个 hash：password change / erasure 换 hash / 未来
 *     reset 一律使旧 bcrypt 结果失效）
 *   → fresh.email === candidate.email（credentials 以 email 定位 identity，
 *     identifier 变化后旧 identifier 不得授权新 identity）
 *   → [afterCheck seam（仅测试）]
 *   → lastLoginAt = now（同一 tx）并以 update 返回的 fresh 行作为最终
 *     identity（禁止返回 pre-bcrypt snapshot）
 *   → COMMIT
 *
 * 任一 fresh 校验失败 → null（调用方按登录失败处理，不得重置成功限流计数）。
 * 不抛带 lifecycle 原因的详细错误——统一 null，避免向登录界面泄露
 * 注销/停用状态差异。
 *
 * JWT 范围说明：本服务保证 credential finalization 不使用 stale
 * pre-erasure 状态、erase 先提交则 DENY、login 先提交则 erase 后提交并
 * 成为最终 DB authority；erased/deleted 的旧 JWT 仍由 server-auth 中央
 * DB recheck DENY。不引入 tokenVersion / JWT blacklist / revocation table。
 */

export type CredentialLoginSeams = {
  /** bcrypt 已成功之后、USER 锁之前挂起（LOGIN-RACE-01/03 stale 构造点） */
  beforeLock?: (tx: Prisma.TransactionClient) => Promise<void>;
  /** USER 锁持有 + lifecycle/hash/email 校验通过后、lastLoginAt 写入前挂起 */
  afterCheck?: (tx: Prisma.TransactionClient) => Promise<void>;
};

/** bcrypt 成功时调用方实际验证过的凭据绑定信息（均来自数据库行） */
export type CredentialLoginCandidate = {
  id: string;
  passwordHash: string;
  email: string;
};

export type CredentialLoginIdentity = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: "STUDENT" | "ADMIN";
};

export async function finalizeCredentialLogin(
  candidate: CredentialLoginCandidate,
  seams?: CredentialLoginSeams,
): Promise<CredentialLoginIdentity | null> {
  return withTransaction(async (tx) => {
    if (seams?.beforeLock) {
      await seams.beforeLock(tx);
    }

    // serialization boundary：与 eraseAccount 同一 USER:<id> 治理锁
    await acquireGovernanceSubjectLock(tx, "USER", candidate.id);

    const fresh = await tx.user.findUnique({
      where: { id: candidate.id },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        role: true,
        passwordHash: true,
        status: true,
        deletedAt: true,
        erasedAt: true,
      },
    });

    const lifecycleOk =
      fresh !== null &&
      fresh.deletedAt === null &&
      fresh.erasedAt === null &&
      (fresh.status === "ACTIVE" || fresh.status === "SUSPENDED");

    if (!lifecycleOk) {
      return null;
    }

    // bcrypt 成功只授权它验证过的那个 hash；identifier 变化同样失效
    if (fresh.passwordHash !== candidate.passwordHash || fresh.email !== candidate.email) {
      return null;
    }

    if (seams?.afterCheck) {
      await seams.afterCheck(tx);
    }

    const identity = await tx.user.update({
      where: { id: candidate.id },
      data: { lastLoginAt: new Date() },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        role: true,
      },
    });

    return {
      id: identity.id,
      email: identity.email,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
      role: identity.role,
    };
  });
}
