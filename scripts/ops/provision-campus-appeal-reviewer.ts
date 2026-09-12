import { parseArgs } from "node:util";

import { assignRole, revokeRole } from "@/lib/rbac/assignment-service";
import { CAMPUS_APPEAL_REVIEWER_ROLE_KEY } from "@/lib/rbac/roles";
import { isRbacError } from "@/lib/rbac/errors";
import { prisma } from "@/lib/prisma";

/**
 * Phase 7A：校区申诉审核员受控 ops 供给入口（Planning Repair 2 冻结，
 * PROVISIONING_BEFORE_7B = YES；角色管理 UI 属 Phase 7B）。
 *
 * 硬合同：
 * - 授权一律走 canonical assignRole/revokeRole seam——本脚本绝不直接写
 *   UserRoleAssignment、绝不 raw SQL 授角色、不绕过 RBAC/治理锁/target
 *   membership 复核/AdminAudit；
 * - actor 必须自身通过 canonical GLOBAL rbac.role.assign 授权
 *   （Phase 7A 窄修后 GLOBAL 授予权可管理任意校区的 CAMPUS 角色）；
 * - 非交互、明确退出码：0 = 成功（含幂等 no-op），1 = 失败（打印用户安全错误）。
 *
 * 用法（自然键定位，绝不假设内部 ID）：
 *   npm run ops:provision-appeal-reviewer -- \
 *     --actor-email <PLATFORM_ADMIN 邮箱> \
 *     --target-email <审核员邮箱> \
 *     --campus-slug <校区 slug> [--revoke]
 *
 * 幂等：重复授予返回既有授权（created=false）并成功退出；撤回未持有的
 * 授权同样幂等成功（removed=false）。
 */

type ParsedOptions = {
  actorEmail: string;
  targetEmail: string;
  campusSlug: string;
  revoke: boolean;
};

function parseOptions(): ParsedOptions {
  const { values } = parseArgs({
    options: {
      "actor-email": { type: "string" },
      "target-email": { type: "string" },
      "campus-slug": { type: "string" },
      revoke: { type: "boolean", default: false },
    },
    strict: true,
  });

  const actorEmail = values["actor-email"]?.trim() ?? "";
  const targetEmail = values["target-email"]?.trim() ?? "";
  const campusSlug = values["campus-slug"]?.trim() ?? "";

  const missing = [
    !actorEmail && "--actor-email",
    !targetEmail && "--target-email",
    !campusSlug && "--campus-slug",
  ].filter(Boolean);

  if (missing.length > 0) {
    console.error(`缺少必填参数：${missing.join("、")}`);
    console.error(
      "用法：npm run ops:provision-appeal-reviewer -- --actor-email <...> --target-email <...> --campus-slug <...> [--revoke]",
    );
    process.exit(1);
  }

  return { actorEmail, targetEmail, campusSlug, revoke: values.revoke ?? false };
}

async function main(): Promise<number> {
  const options = parseOptions();

  // 自然键解析：actor / target / campus 全部按业务唯一标识定位
  const actor = await prisma.user.findUnique({
    where: { email: options.actorEmail },
    select: { id: true, status: true },
  });
  if (!actor) {
    console.error(`失败：actor 不存在（${options.actorEmail}）`);
    return 1;
  }
  if (actor.status !== "ACTIVE") {
    console.error(`失败：actor 账号非 ACTIVE（${options.actorEmail}）`);
    return 1;
  }

  const target = await prisma.user.findUnique({
    where: { email: options.targetEmail },
    select: { id: true },
  });
  if (!target) {
    console.error(`失败：target 不存在（${options.targetEmail}）`);
    return 1;
  }

  const campus = await prisma.campus.findUnique({
    where: { slug: options.campusSlug },
    select: { id: true, name: true },
  });
  if (!campus) {
    console.error(`失败：校区不存在（${options.campusSlug}）`);
    return 1;
  }

  const input = {
    actorId: actor.id,
    targetUserId: target.id,
    roleKey: CAMPUS_APPEAL_REVIEWER_ROLE_KEY,
    campusId: campus.id,
  };

  if (options.revoke) {
    const { removed } = await revokeRole(input);
    console.log(
      removed
        ? `✅ 已撤回 ${options.targetEmail} 在校区「${campus.name}」的 ${CAMPUS_APPEAL_REVIEWER_ROLE_KEY} 角色`
        : `ℹ️ 该用户在校区「${campus.name}」未持有 ${CAMPUS_APPEAL_REVIEWER_ROLE_KEY}（幂等 no-op）`,
    );
    return 0;
  }

  const { created } = await assignRole(input);
  console.log(
    created
      ? `✅ 已授予 ${options.targetEmail} 在校区「${campus.name}」的 ${CAMPUS_APPEAL_REVIEWER_ROLE_KEY} 角色（审计已记录）`
      : `ℹ️ 该用户已持有校区「${campus.name}」的 ${CAMPUS_APPEAL_REVIEWER_ROLE_KEY} 角色（幂等 no-op）`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    // canonical seam 的业务错误（RBAC/授权/membership）打印用户安全 message；
    // 其余为意外故障，完整输出便于 ops 排查。
    if (isRbacError(error)) {
      console.error(`失败：${error.message}`);
    } else {
      console.error("失败：未预期异常");
      console.error(error);
    }
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
