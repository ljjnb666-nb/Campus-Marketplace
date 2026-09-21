import type { User } from "@prisma/client";

import { createActiveMembership } from "@/lib/campus/membership-service";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { recordSignupAcceptances } from "@/lib/legal/policy-service";
import { withTransaction } from "@/lib/prisma";

/**
 * Phase 7H Final Review Repair 1（FR01）：注册事务权威
 * （registration transaction authority）。
 *
 * TOCTOU 关闭：此前 registerUser 在事务外 pre-read Campus.isActive，与
 * deactivateGovernanceCampus（CAMPUS governance lock）没有共同 serialization
 * boundary——"停用先提交、注册后提交"的非法交错在窗口内可能发生。
 *
 * 现冻结合同：
 * - 注册事务先经 acquireGovernanceSubjectLocks() 取得
 *   CAMPUS:<campusId> governance subject 锁（与 campus deactivate /
 *   activate / metadata update 完全同一 helper、同一 730501 namespace，
 *   绝不创建第二套 campus lock namespace）；
 * - 锁内 locked re-read Campus（isActive: true 谓词）——admission 判定
 *   与写入在同一持锁窗口内完成；
 * - User.create → CampusMembership.create(ACTIVE) → legal acceptances
 *   同事务原子提交（零部分注册：任一步失败整体回滚）。
 *
 * 线性化合同（只有两种合法终态）：
 *   A. 注册先取得锁 → active recheck 通过 → 注册提交 → 停用随后提交
 *      ⇒ 注册被接受，校区最终 inactive（注册线性化早于停用，合法）；
 *   B. 停用先提交 → 注册后取得锁 → locked recheck 见 inactive
 *      ⇒ 注册被拒，ZERO User / CampusMembership / PolicyAcceptance。
 *
 * bcrypt password hash 由调用方在事务外计算——绝不在持有 CAMPUS 锁的
 * 窗口内做昂贵哈希（锁持有时间最小化纪律）。
 *
 * 校区不可用（不存在 / 已停用）统一映射单一 reason，由调用方给出门面
 * 文案——无存在性 oracle。
 */

export type RegisterCampusUserInput = {
  name: string;
  email: string;
  /** 调用方在事务外完成的 bcrypt hash（绝不传入明文密码） */
  passwordHash: string;
  schoolName: string;
  campusId: string;
  acceptedDocumentIds: string[];
};

export type RegistrationOutcome =
  | { ok: true; user: User }
  | { ok: false; reason: "CAMPUS_NOT_AVAILABLE" };

export async function registerActiveCampusUser(
  input: RegisterCampusUserInput,
): Promise<RegistrationOutcome> {
  return withTransaction(async (tx) => {
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "CAMPUS", subjectId: input.campusId },
    ]);

    // 锁定 active re-read：不存在与已停用同形拒绝（无存在性 oracle）
    const campus = await tx.campus.findFirst({
      where: { id: input.campusId, isActive: true },
      select: { id: true },
    });
    if (!campus) {
      return { ok: false, reason: "CAMPUS_NOT_AVAILABLE" as const };
    }

    const user = await tx.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash: input.passwordHash,
        schoolName: input.schoolName,
        campusId: input.campusId,
      },
    });

    // Phase 6A：注册同事务建立 ACTIVE CampusMembership（加入校区开放，
    // 学生认证是独立的更高信任层级）
    await createActiveMembership(tx, {
      userId: user.id,
      campusId: input.campusId,
    });

    // 同意证据与用户创建同事务：不存在"已注册但无同意记录"的中间态
    // （recordSignupAcceptances 内部 fail-closed 校验当前 required 集合，
    // 并按固定顺序取 policy 锁——730502 与 CAMPUS subject 锁跨 namespace 无环）。
    // P2002（邮箱唯一冲突）与 GovernanceError 原样上抛，由 Server Action
    // 统一映射安全文案；campus 不可用不走异常通道（ok:false 单一 reason）。
    await recordSignupAcceptances(tx, user.id, input.acceptedDocumentIds);

    return { ok: true, user };
  });
}
