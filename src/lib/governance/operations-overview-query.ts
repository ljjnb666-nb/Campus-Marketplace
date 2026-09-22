import type { Prisma } from "@prisma/client";

import {
  authorizedEnforcementBranches,
  QUEUE_STATUSES,
} from "@/lib/appeals/review-queue";
import type { AppealReviewAccess } from "@/lib/appeals/reviewer-access";
import {
  authorizedDisputeBranches,
} from "@/lib/disputes/dispute-query";
import type { DisputeReviewAccess } from "@/lib/disputes/dispute-access";
import {
  authorizedReportBranches,
} from "@/lib/reports/report-query";
import type { ReportReviewAccess } from "@/lib/reports/report-access";
import {
  verificationScopePredicate,
} from "@/lib/campus/verification-review-query";
import type { VerificationReviewAccess } from "@/lib/campus/verification-review-access";
import { authorizedSupportBranches } from "@/lib/support/support-query";
import type { SupportManageAccess } from "@/lib/support/support-access";
import { prisma } from "@/lib/prisma";

/**
 * Phase 7H：/governance 运营落地仪表盘的授权读模型（READ-ONLY）。
 *
 * 硬合同（Planning §4-§10/§44/§45/§60 冻结）：
 * - CAPABILITY-AWARE / SCOPE-AWARE：每个域独立执行 capability visibility——
 *   未授权域以 null 传入，其聚合查询结构性不执行（anti-oracle：不是
 *   "查完再隐藏"）。root access ≠ all-card access。
 * - 授权谓词复用各域队列查询模块导出的同一分支构造器（§8 shared
 *   authorization predicate：绝无第二套 scope 逻辑）——UNSCOPED 行仅 GLOBAL
 *   （reports/support），campus reviewer 仅 exact campus，零 scope 永远空集。
 * - count 一致性（§8/§49）：activeCount 使用与队列 overdueOnly 同源的
 *   active 状态集（各域 SLA truth 的 active 集合），overdueCount = active ∧
 *   到期，两谓词皆为 DB 侧精确镜像（见各域 SLA 模块：reports
 *   closedAt null / verifications PENDING / appeals SUBMITTED+IN_REVIEW /
 *   disputes OPEN+IN_REVIEW / support OPEN+IN_PROGRESS）。
 * - PII-MINIMAL（§44/§6）：summary 只允许 activeCount/overdueCount/
 *   assignedToMeCount/oldestDueAt/href——绝不 preload 用户名/email/phone/
 *   reason/description/evidence/note/asset ref。Dashboard 是 summary，
 *   不是第二个 queue。
 * - READ-ONLY：本模块零 mutation、零 audit 写入（§9/§59）；绝不驱动
 *   auto resolve / assign / enforce。
 * - 性能（§60）：每域至多 4 条聚合（并行），五域间并行，绝不 load all rows
 *   后 JS 计数，零 N+1。
 */

export type OperationsQueueDomain =
  | "reports"
  | "verifications"
  | "appeals"
  | "disputes"
  | "support";

export type OperationsQueueSummary = {
  domain: OperationsQueueDomain;
  title: string;
  href: string;
  /** == 对应 /governance 队列的 active 谓词计数（§8 count 一致性） */
  activeCount: number;
  /** == active ∧ 到期（各域 SLA truth，绝不新定义 SLA） */
  overdueCount: number;
  /** 仅存在 assignment 语义的域返回（reports/disputes/support） */
  assignedToMeCount?: number;
  /** active 集合中最早的办理时限（ISO string；空集为 null） */
  oldestDueAt: string | null;
};

export type OperationsOverviewInput = {
  viewerId: string;
  /** 未授权域必须传 null（anti-oracle：null 域的聚合查询结构性不执行） */
  reports: ReportReviewAccess | null;
  verifications: VerificationReviewAccess | null;
  appeals: AppealReviewAccess | null;
  disputes: DisputeReviewAccess | null;
  support: SupportManageAccess | null;
};

const QUEUE_SUMMARY_META: Record<
  OperationsQueueDomain,
  { title: string; href: string }
> = {
  reports: { title: "举报处理", href: "/governance/reports" },
  verifications: { title: "认证审核", href: "/governance/verifications" },
  appeals: { title: "申诉审核", href: "/governance/appeals" },
  disputes: { title: "纠纷处理", href: "/governance/disputes" },
  support: { title: "支持工单", href: "/governance/support" },
};

function emptySummary(domain: OperationsQueueDomain): OperationsQueueSummary {
  const meta = QUEUE_SUMMARY_META[domain];
  return {
    domain,
    title: meta.title,
    href: meta.href,
    activeCount: 0,
    overdueCount: 0,
    oldestDueAt: null,
  };
}

// ── 各域 active/overdue DB 谓词（与队列 overdueOnly 过滤逐字段同语义）────────

function loadReportSummary(viewerId: string, now: Date) {
  return async (access: ReportReviewAccess): Promise<OperationsQueueSummary> => {
    const branches = await authorizedReportBranches(access);
    // fail-closed：零有效 scope → 零聚合（与队列空页同语义）
    if (branches.length === 0) {
      return emptySummary("reports");
    }
    const scope: Prisma.ModerationCaseWhereInput = {
      OR: branches.map((branch) => ({
        campusId: branch.campusId,
        scopeKey: branch.scopeKey,
      })),
    };
    // active = 未结案（SLA truth：closedAt === null）；overdue = active ∧ dueAt < now
    const [activeCount, overdueCount, assignedToMeCount, aggregate] =
      await Promise.all([
        prisma.moderationCase.count({ where: { AND: [scope, { closedAt: null }] } }),
        prisma.moderationCase.count({
          where: { AND: [scope, { closedAt: null, dueAt: { lt: now } }] },
        }),
        prisma.moderationCase.count({
          where: { AND: [scope, { closedAt: null, assignedToId: viewerId }] },
        }),
        prisma.moderationCase.aggregate({
          _min: { dueAt: true },
          where: { AND: [scope, { closedAt: null }] },
        }),
      ]);
    return {
      ...emptySummary("reports"),
      activeCount,
      overdueCount,
      assignedToMeCount,
      oldestDueAt: aggregate._min.dueAt ? aggregate._min.dueAt.toISOString() : null,
    };
  };
}

function loadVerificationSummary(now: Date) {
  return async (access: VerificationReviewAccess): Promise<OperationsQueueSummary> => {
    const scopePredicate = verificationScopePredicate(access);
    if (scopePredicate === null) {
      return emptySummary("verifications");
    }
    // active = PENDING（SLA truth）；overdue = PENDING ∧ reviewDueAt < now
    const [activeCount, overdueCount, aggregate] = await Promise.all([
      prisma.userVerification.count({
        where: { AND: [scopePredicate, { status: "PENDING" }] },
      }),
      prisma.userVerification.count({
        where: {
          AND: [scopePredicate, { status: "PENDING", reviewDueAt: { lt: now } }],
        },
      }),
      prisma.userVerification.aggregate({
        _min: { reviewDueAt: true },
        where: { AND: [scopePredicate, { status: "PENDING" }] },
      }),
    ]);
    return {
      ...emptySummary("verifications"),
      activeCount,
      overdueCount,
      oldestDueAt: aggregate._min.reviewDueAt
        ? aggregate._min.reviewDueAt.toISOString()
        : null,
    };
  };
}

function loadAppealSummary(now: Date) {
  return async (access: AppealReviewAccess): Promise<OperationsQueueSummary> => {
    const branches = await authorizedEnforcementBranches(access);
    if (branches.length === 0) {
      return emptySummary("appeals");
    }
    const scope: Prisma.AppealWhereInput = { enforcementAction: { OR: branches } };
    // active = status ∈ QUEUE_STATUSES（队列自身的 active 预过滤，同一常量）；
    // overdue = active ∧ reviewDueAt < now（SLA truth）
    const [activeCount, overdueCount, aggregate] = await Promise.all([
      prisma.appeal.count({
        where: { AND: [scope, { status: { in: QUEUE_STATUSES } }] },
      }),
      prisma.appeal.count({
        where: {
          AND: [scope, { status: { in: QUEUE_STATUSES }, reviewDueAt: { lt: now } }],
        },
      }),
      prisma.appeal.aggregate({
        _min: { reviewDueAt: true },
        where: { AND: [scope, { status: { in: QUEUE_STATUSES } }] },
      }),
    ]);
    return {
      ...emptySummary("appeals"),
      activeCount,
      overdueCount,
      oldestDueAt: aggregate._min.reviewDueAt
        ? aggregate._min.reviewDueAt.toISOString()
        : null,
    };
  };
}

function loadDisputeSummary(viewerId: string, now: Date) {
  return async (access: DisputeReviewAccess): Promise<OperationsQueueSummary> => {
    const branches = await authorizedDisputeBranches(access);
    if (branches.length === 0) {
      return emptySummary("disputes");
    }
    const scope: Prisma.RentalDisputeWhereInput = {
      OR: branches.map((branch) => ({
        campusId: branch.campusId,
        scopeKey: branch.scopeKey,
      })),
    };
    // active = OPEN | IN_REVIEW（SLA truth）；overdue = active ∧ dueAt < now
    const [activeCount, overdueCount, assignedToMeCount, aggregate] =
      await Promise.all([
        prisma.rentalDispute.count({
          where: { AND: [scope, { status: { in: ["OPEN", "IN_REVIEW"] } }] },
        }),
        prisma.rentalDispute.count({
          where: {
            AND: [
              scope,
              { status: { in: ["OPEN", "IN_REVIEW"] }, dueAt: { lt: now } },
            ],
          },
        }),
        prisma.rentalDispute.count({
          where: {
            AND: [scope, { status: { in: ["OPEN", "IN_REVIEW"] }, assignedToId: viewerId }],
          },
        }),
        prisma.rentalDispute.aggregate({
          _min: { dueAt: true },
          where: { AND: [scope, { status: { in: ["OPEN", "IN_REVIEW"] } }] },
        }),
      ]);
    return {
      ...emptySummary("disputes"),
      activeCount,
      overdueCount,
      assignedToMeCount,
      oldestDueAt: aggregate._min.dueAt ? aggregate._min.dueAt.toISOString() : null,
    };
  };
}

function loadSupportSummary(viewerId: string, now: Date) {
  return async (access: SupportManageAccess): Promise<OperationsQueueSummary> => {
    const branches = await authorizedSupportBranches(access);
    if (branches.length === 0) {
      return emptySummary("support");
    }
    const scope: Prisma.SupportTicketWhereInput = {
      OR: branches.map((branch) => ({
        campusId: branch.campusId,
        scopeKey: branch.scopeKey,
      })),
    };
    // active = OPEN | IN_PROGRESS（SLA truth）；overdue = active ∧ dueAt < now
    const [activeCount, overdueCount, assignedToMeCount, aggregate] =
      await Promise.all([
        prisma.supportTicket.count({
          where: { AND: [scope, { status: { in: ["OPEN", "IN_PROGRESS"] } }] },
        }),
        prisma.supportTicket.count({
          where: {
            AND: [
              scope,
              { status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { lt: now } },
            ],
          },
        }),
        prisma.supportTicket.count({
          where: {
            AND: [
              scope,
              { status: { in: ["OPEN", "IN_PROGRESS"] }, assignedToId: viewerId },
            ],
          },
        }),
        prisma.supportTicket.aggregate({
          _min: { dueAt: true },
          where: { AND: [scope, { status: { in: ["OPEN", "IN_PROGRESS"] } }] },
        }),
      ]);
    return {
      ...emptySummary("support"),
      activeCount,
      overdueCount,
      assignedToMeCount,
      oldestDueAt: aggregate._min.dueAt ? aggregate._min.dueAt.toISOString() : null,
    };
  };
}

/**
 * 汇总五域运营队列 summary。只对显式传入 access 的域执行聚合（capability
 * 门前置），未授权域零查询；域间并行，域内 count/aggregate 并行。
 */
export async function loadOperationsOverview(
  input: OperationsOverviewInput,
): Promise<OperationsQueueSummary[]> {
  const now = new Date();
  const reportsTask = input.reports
    ? loadReportSummary(input.viewerId, now)(input.reports)
    : null;
  const verificationsTask = input.verifications
    ? loadVerificationSummary(now)(input.verifications)
    : null;
  const appealsTask = input.appeals
    ? loadAppealSummary(now)(input.appeals)
    : null;
  const disputesTask = input.disputes
    ? loadDisputeSummary(input.viewerId, now)(input.disputes)
    : null;
  const supportTask = input.support
    ? loadSupportSummary(input.viewerId, now)(input.support)
    : null;

  const [reports, verifications, appeals, disputes, support] = await Promise.all([
    reportsTask,
    verificationsTask,
    appealsTask,
    disputesTask,
    supportTask,
  ]);

  const summaries: OperationsQueueSummary[] = [];
  if (reports) summaries.push(reports);
  if (verifications) summaries.push(verifications);
  if (appeals) summaries.push(appeals);
  if (disputes) summaries.push(disputes);
  if (support) summaries.push(support);
  return summaries;
}
