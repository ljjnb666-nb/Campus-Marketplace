import { Prisma, type Campus } from "@prisma/client";

import {
  governanceError,
} from "@/lib/governance/domain-errors";
import {
  acquireGovernanceSubjectLocks,
} from "@/lib/governance/governance-lock";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import {
  CAMPUS_MANAGE_PERMISSION,
} from "@/lib/campus/campus-admin-access";
import {
  loadAuthorizationContext,
  requirePermissionInContext,
} from "@/lib/rbac/service";
import { withTransaction } from "@/lib/prisma";

/**
 * Phase 7H：校区治理 canonical mutation service（/governance/campuses 专用）。
 *
 * 硬合同（Planning §17/§21-§28/§58 冻结）：
 * - 授权：campus.manage = GLOBAL ONLY（§17——Campus entity mutation 修改的
 *   是租户边界本身）。actor account ACTIVE 由 requirePermissionInContext 在
 *   锁内复核（AUTH_ACCOUNT_INACTIVE）；绝不使用 requireAdmin() / User.role。
 * - 锁序（§25 冻结）：USER:actor → CAMPUS:<targetCampus>（governance subject
 *   锁命名空间 730501 的稳定 campus 键）→ 锁定授权重读（loadAuthorizationContext
 *   (actorId, tx) + requirePermissionInContext）→ mutation → audit。禁止
 *   "授权 pre-read only → long work → raw update"（role revoke TOCTOU 同源）。
 * - server action 绝不直接 prisma.campus.update()（§24）：authorization/
 *   locking/validation/mutation/audit 全部收敛在本 service。
 * - slug 冻结（§21/§26/§27）：slug 仅 create 时接受，create/update 的任何
 *   路径结构性不含 slug 字段——slug IMMUTABLE，unique 冲突映射稳定机器码
 *   CAMPUS_SLUG_CONFLICT（绝不静默追加随机后缀）。
 * - Campus.isActive 语义（§22 冻结）：= campus availability / admission
 *   configuration，绝不是 Phase 10 kill switch——deactivate 绝不级联
 *   suspend membership / moderate listings / cancel orders / close disputes /
 *   close support / revoke roles / revoke verification。same-state retry
 *   幂等（无 mutation 即无 audit，§28）。
 * - 审计（§58）：CAMPUS_CREATED / CAMPUS_UPDATED / CAMPUS_ACTIVATED /
 *   CAMPUS_DEACTIVATED；metadata 仅机器字段（previousIsActive/newIsActive
 *   布尔值），name/schoolName/district 等自由文本因白名单结构而结构性
 *   不可进入 audit metadata。
 */

/** slug 稳定格式（§26）：小写字母/数字，连字符分段，不以连字符开头结尾。 */
const CAMPUS_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CAMPUS_SLUG_MAX_LENGTH = 64;

function assertNonEmpty(value: string, code: "CAMPUS_INPUT_INVALID"): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw governanceError(code);
  }
  return trimmed;
}

function assertValidSlug(slug: string): string {
  const trimmed = slug.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > CAMPUS_SLUG_MAX_LENGTH ||
    !CAMPUS_SLUG_PATTERN.test(trimmed)
  ) {
    throw governanceError("CAMPUS_SLUG_INVALID");
  }
  return trimmed;
}

/**
 * Campus 表唯一约束只有 slug（@unique）：create 路径上的 P2002 恒为
 * slug 冲突 → 稳定机器码（meta.target 存在 string / string[] 双形态，
 * 见 6C-1B 踩坑沉淀，两形态都识别）。
 */
function isCampusSlugConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  if (typeof target === "string") {
    return target.includes("slug");
  }
  if (Array.isArray(target)) {
    return target.some((item) => typeof item === "string" && item.includes("slug"));
  }
  // target 缺省（驱动差异）：Campus 唯一索引只有 slug，按冲突处理
  return true;
}

/**
 * 锁定授权重读（§25 冻结链的核心步骤）：事务内重新加载 authorization
 * context 并要求 GLOBAL campus.manage——错误存在的 campus.manage @ CAMPUS:A
 * grant 在这里被 requirePermissionInContext 拒绝（无 targetCampusId 时仅
 * GLOBAL grant 放行），actor 停用同样在此 fail closed。
 */
async function requireCampusManageInTx(
  tx: Prisma.TransactionClient,
  actorId: string,
): Promise<void> {
  const context = await loadAuthorizationContext(actorId, tx);
  await requirePermissionInContext(context, CAMPUS_MANAGE_PERMISSION);
}

export type CreateGovernanceCampusInput = {
  actorId: string;
  name: string;
  slug: string;
  schoolName: string;
  district?: string | null;
};

/**
 * create Campus（§26）：GLOBAL campus.manage；slug 服务器校验 + unique；
 * 默认 isActive = true（创建即上架可注册；初始 inactive 需求 v1 不开放）。
 */
export async function createGovernanceCampus(
  input: CreateGovernanceCampusInput,
): Promise<Campus> {
  const name = assertNonEmpty(input.name, "CAMPUS_INPUT_INVALID");
  const slug = assertValidSlug(input.slug);
  const schoolName = assertNonEmpty(input.schoolName, "CAMPUS_INPUT_INVALID");
  const district =
    input.district === undefined || input.district === null
      ? null
      : assertNonEmpty(input.district, "CAMPUS_INPUT_INVALID");

  return withTransaction(async (tx) => {
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "USER", subjectId: input.actorId },
    ]);
    await requireCampusManageInTx(tx, input.actorId);

    try {
      const campus = await tx.campus.create({
        data: { name, slug, schoolName, district, isActive: true },
      });

      await recordAdminAudit(
        {
          actorId: input.actorId,
          action: "CAMPUS_CREATED",
          targetType: "CAMPUS",
          targetId: campus.id,
          campusId: campus.id,
          metadata: null,
        },
        tx,
      );

      return campus;
    } catch (error) {
      if (isCampusSlugConflict(error)) {
        throw governanceError("CAMPUS_SLUG_CONFLICT");
      }
      throw error;
    }
  });
}

export type UpdateGovernanceCampusMetadataInput = {
  actorId: string;
  campusId: string;
  name?: string;
  schoolName?: string;
  district?: string | null;
};

/**
 * update 校区元数据（§27）：仅 name / schoolName / district 可变——
 * id / slug / createdAt 结构性不在 update data 内（slug IMMUTABLE）。
 */
export async function updateGovernanceCampusMetadata(
  input: UpdateGovernanceCampusMetadataInput,
): Promise<Campus> {
  const data: { name?: string; schoolName?: string; district?: string | null } = {};
  if (input.name !== undefined) {
    data.name = assertNonEmpty(input.name, "CAMPUS_INPUT_INVALID");
  }
  if (input.schoolName !== undefined) {
    data.schoolName = assertNonEmpty(input.schoolName, "CAMPUS_INPUT_INVALID");
  }
  if (input.district !== undefined) {
    data.district =
      input.district === null ? null : assertNonEmpty(input.district, "CAMPUS_INPUT_INVALID");
  }

  return withTransaction(async (tx) => {
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "USER", subjectId: input.actorId },
      { subjectType: "CAMPUS", subjectId: input.campusId },
    ]);
    await requireCampusManageInTx(tx, input.actorId);

    const campus = await tx.campus.findUnique({ where: { id: input.campusId } });
    if (!campus) {
      throw governanceError("CAMPUS_NOT_FOUND");
    }

    // 幂等 no-op：零字段变更原样返回（无 mutation 即无 audit）
    if (Object.keys(data).length === 0) {
      return campus;
    }

    const updated = await tx.campus.update({
      where: { id: input.campusId },
      data,
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "CAMPUS_UPDATED",
        targetType: "CAMPUS",
        targetId: input.campusId,
        campusId: input.campusId,
        metadata: null,
      },
      tx,
    );

    return updated;
  });
}

async function toggleGovernanceCampusActive(input: {
  actorId: string;
  campusId: string;
  nextIsActive: boolean;
}): Promise<Campus> {
  return withTransaction(async (tx) => {
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "USER", subjectId: input.actorId },
      { subjectType: "CAMPUS", subjectId: input.campusId },
    ]);
    await requireCampusManageInTx(tx, input.actorId);

    const campus = await tx.campus.findUnique({ where: { id: input.campusId } });
    if (!campus) {
      throw governanceError("CAMPUS_NOT_FOUND");
    }

    // same-state retry = 幂等（§28）：无状态迁移即无 mutation 即无 audit；
    // 也绝不触发任何级联（§22：Campus.isActive ≠ kill switch）
    if (campus.isActive === input.nextIsActive) {
      return campus;
    }

    const updated = await tx.campus.update({
      where: { id: input.campusId },
      data: { isActive: input.nextIsActive },
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: input.nextIsActive ? "CAMPUS_ACTIVATED" : "CAMPUS_DEACTIVATED",
        targetType: "CAMPUS",
        targetId: input.campusId,
        campusId: input.campusId,
        metadata: {
          previousIsActive: !input.nextIsActive,
          newIsActive: input.nextIsActive,
        },
      },
      tx,
    );

    return updated;
  });
}

/**
 * activate / deactivate（§28）：canonical service + same-state 幂等 +
 * 机器字段 audit。deactivate 仅改变 campus availability / admission
 * 配置位——existing obligations（membership/listing/order/dispute/support/
 * role/verification）全部保留（§22/§51）。
 */
export function activateGovernanceCampus(input: {
  actorId: string;
  campusId: string;
}): Promise<Campus> {
  return toggleGovernanceCampusActive({ ...input, nextIsActive: true });
}

export function deactivateGovernanceCampus(input: {
  actorId: string;
  campusId: string;
}): Promise<Campus> {
  return toggleGovernanceCampusActive({ ...input, nextIsActive: false });
}
