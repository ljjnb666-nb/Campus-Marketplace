import { beforeEach, describe, expect, it, vi } from "vitest";

const { reportFindUnique, userFindMany } = vi.hoisted(() => ({
  reportFindUnique: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    report: { findUnique: reportFindUnique },
    moderationCase: {},
    campus: {},
    user: { findMany: userFindMany },
  },
}));

import { loadAuthorizedReportDetail } from "@/lib/reports/report-query";
import type { AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7E：详情授权读模型合同（真实 PG 行为见 integration P01..P06；
 * 此处锁定统一拒绝形状、safeTargetLabel 分支与 privacy fallback DTO 形状）。
 */

function context(overrides: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    userId: "viewer-1",
    accountActive: true,
    activeCampusIds: ["A"],
    grants: [
      { roleKey: "CAMPUS_REPORT_REVIEWER", scope: "CAMPUS", campusId: "A", permissionKeys: ["report.review"] },
    ],
    ...overrides,
  };
}

const CAMPUS_A_ACCESS = { global: false, campusIds: ["A"] };

function reportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "report-1",
    status: "OPEN",
    reason: "SCAM_RISK",
    targetType: "PRODUCT",
    detail: "举报详情",
    createdAt: new Date("2026-09-16T08:00:00.000Z"),
    handledAt: null,
    handledNote: null,
    reporterId: "reporter-1",
    campusId: "A",
    scopeKey: "CAMPUS:A",
    campus: { name: "校区A" },
    product: { title: "商品甲" },
    errandTask: null,
    serviceListing: null,
    rentalListing: null,
    targetUserId: null,
    moderationCase: {
      id: "case-1",
      openedAt: new Date("2026-09-16T08:00:00.000Z"),
      dueAt: new Date("2026-09-18T08:00:00.000Z"),
      lastActivityAt: new Date("2026-09-16T08:00:00.000Z"),
      closedAt: null,
      assignedToId: null,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  userFindMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
    args.where.id.in
      .filter((id) => id !== "ghost-user")
      .map((id) => ({ id, name: `用户-${id}`, deletedAt: null, erasedAt: null })),
  );
});

describe("loadAuthorizedReportDetail（统一拒绝）", () => {
  it("missing report / 缺 case / malformed scope / 越权 → 统一 { ok:false }（反 oracle）", async () => {
    reportFindUnique.mockResolvedValue(null);
    expect(
      await loadAuthorizedReportDetail({
        viewerId: "v1", context: context(), access: CAMPUS_A_ACCESS, reportId: "r1",
      }),
    ).toEqual({ ok: false });

    reportFindUnique.mockResolvedValue(reportRow({ moderationCase: null }));
    expect(
      await loadAuthorizedReportDetail({
        viewerId: "v1", context: context(), access: CAMPUS_A_ACCESS, reportId: "r1",
      }),
    ).toEqual({ ok: false });

    reportFindUnique.mockResolvedValue(reportRow({ campusId: "A", scopeKey: "UNSCOPED" }));
    expect(
      await loadAuthorizedReportDetail({
        viewerId: "v1", context: context(), access: CAMPUS_A_ACCESS, reportId: "r1",
      }),
    ).toEqual({ ok: false });

    reportFindUnique.mockResolvedValue(reportRow({ campusId: "B", scopeKey: "CAMPUS:B" }));
    expect(
      await loadAuthorizedReportDetail({
        viewerId: "v1", context: context(), access: CAMPUS_A_ACCESS, reportId: "r1",
      }),
    ).toEqual({ ok: false });
  });

  it("UNSCOPED 仅 GLOBAL 读者；campus reviewer → { ok:false }", async () => {
    reportFindUnique.mockResolvedValue(reportRow({ campusId: null, scopeKey: "UNSCOPED" }));
    expect(
      await loadAuthorizedReportDetail({
        viewerId: "v1", context: context(), access: CAMPUS_A_ACCESS, reportId: "r1",
      }),
    ).toEqual({ ok: false });

    const result = await loadAuthorizedReportDetail({
      viewerId: "v1",
      context: context({
        activeCampusIds: [],
        grants: [
          { roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["report.review"] },
        ],
      }),
      access: { global: true, campusIds: [] },
      reportId: "r1",
    });
    expect(result.ok).toBe(true);
  });
});

describe("loadAuthorizedReportDetail（DTO 形状）", () => {
  it("CAMPUS PRODUCT 详情：scope 标签/领用人/时钟/scopeAuthorized 全量呈现", async () => {
    const dueAt = new Date("2026-09-18T08:00:00.000Z");
    reportFindUnique.mockResolvedValue(
      reportRow({
        handledAt: new Date("2026-09-17T08:00:00.000Z"),
        handledNote: "上次备注",
        status: "IN_REVIEW",
        moderationCase: {
          id: "case-1",
          openedAt: new Date("2026-09-16T08:00:00.000Z"),
          dueAt,
          lastActivityAt: new Date("2026-09-17T08:00:00.000Z"),
          closedAt: null,
          assignedToId: "viewer-1",
        },
      }),
    );

    const result = await loadAuthorizedReportDetail({
      viewerId: "viewer-1", context: context(), access: CAMPUS_A_ACCESS, reportId: "r1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { detail } = result;
    expect(detail.safeTargetLabel).toBe("商品：商品甲");
    expect(detail.scopeLabel).toBe("校区：校区A");
    expect(detail.reporterName).toBe("用户-reporter-1");
    expect(detail.handledNote).toBe("上次备注");
    expect(detail.caseTiming.overdue).toBe(false);
    expect(detail.assignedReviewer).toEqual({ id: "viewer-1", displayName: "用户-viewer-1" });
    expect(detail.selfAssigned).toBe(true);
    expect(detail.scopeAuthorized).toBe(true);
  });

  it("USER 目标走安全身份标签；missing 身份统一 fallback（P04）", async () => {
    reportFindUnique.mockResolvedValue(
      reportRow({
        targetType: "USER",
        product: null,
        targetUserId: "ghost-user",
        campusId: null,
        scopeKey: "UNSCOPED",
      }),
    );

    const result = await loadAuthorizedReportDetail({
      viewerId: "v1",
      context: context({
        activeCampusIds: [],
        grants: [
          { roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["report.review"] },
        ],
      }),
      access: { global: true, campusIds: [] },
      reportId: "r1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.detail.safeTargetLabel).toBe("用户：已注销用户");
    expect(result.detail.scopeLabel).toBe("平台级");
  });

  it("MESSAGE 目标：队列/详情均不携带消息内容（P03）", async () => {
    reportFindUnique.mockResolvedValue(reportRow({ targetType: "MESSAGE", product: null }));

    const result = await loadAuthorizedReportDetail({
      viewerId: "v1", context: context(), access: CAMPUS_A_ACCESS, reportId: "r1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.detail.safeTargetLabel).toBe("消息举报");
    expect(JSON.stringify(result.detail)).not.toContain("content");
  });

  it("四类 listing 目标的 safeTargetLabel 分支", async () => {
    for (const [targetType, expected, listing] of [
      ["ERRAND_TASK", "任务：跑腿甲", { errandTask: { title: "跑腿甲" }, product: null }],
      ["SERVICE_LISTING", "服务：服务甲", { serviceListing: { title: "服务甲" }, product: null }],
      ["RENTAL_LISTING", "租赁：租赁甲", { rentalListing: { title: "租赁甲" }, product: null }],
    ] as const) {
      reportFindUnique.mockResolvedValue(reportRow({ targetType, ...listing }));
      const result = await loadAuthorizedReportDetail({
        viewerId: "v1", context: context(), access: CAMPUS_A_ACCESS, reportId: "r1",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.detail.safeTargetLabel).toBe(expected);
      }
    }
  });
});
