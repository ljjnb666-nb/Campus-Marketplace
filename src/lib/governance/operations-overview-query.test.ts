import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  campusFindMany,
  caseCount,
  caseAggregate,
  verificationCount,
  verificationAggregate,
  appealCount,
  appealAggregate,
  disputeCount,
  disputeAggregate,
  supportCount,
  supportAggregate,
} = vi.hoisted(() => ({
  campusFindMany: vi.fn(),
  caseCount: vi.fn(),
  caseAggregate: vi.fn(),
  verificationCount: vi.fn(),
  verificationAggregate: vi.fn(),
  appealCount: vi.fn(),
  appealAggregate: vi.fn(),
  disputeCount: vi.fn(),
  disputeAggregate: vi.fn(),
  supportCount: vi.fn(),
  supportAggregate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    campus: { findMany: campusFindMany },
    moderationCase: { count: caseCount, aggregate: caseAggregate },
    userVerification: { count: verificationCount, aggregate: verificationAggregate },
    appeal: { count: appealCount, aggregate: appealAggregate },
    rentalDispute: { count: disputeCount, aggregate: disputeAggregate },
    supportTicket: { count: supportCount, aggregate: supportAggregate },
  },
}));

import { loadOperationsOverview } from "@/lib/governance/operations-overview-query";

/**
 * O 矩阵（query seam 层，Planning §45/§48）：
 * - anti-oracle：未授权域传 null → 该域聚合查询结构性不执行（O02）；
 * - 授权谓词复用各域队列分支构造器（UNSCOPED 仅 GLOBAL；campus reviewer
 *   仅 exact pair）；assignedToMe 仅存在 assignment 语义的域返回。
 */

const VIEWER = "viewer-1";

beforeEach(() => {
  for (const mock of [
    campusFindMany,
    caseCount,
    caseAggregate,
    verificationCount,
    verificationAggregate,
    appealCount,
    appealAggregate,
    disputeCount,
    disputeAggregate,
    supportCount,
    supportAggregate,
  ]) {
    mock.mockReset();
  }
  campusFindMany.mockResolvedValue([{ id: "A" }, { id: "B" }]);
  for (const countMock of [caseCount, verificationCount, appealCount, disputeCount, supportCount]) {
    countMock.mockResolvedValue(0);
  }
  caseAggregate.mockResolvedValue({ _min: { dueAt: null } });
  verificationAggregate.mockResolvedValue({ _min: { reviewDueAt: null } });
  appealAggregate.mockResolvedValue({ _min: { reviewDueAt: null } });
  disputeAggregate.mockResolvedValue({ _min: { dueAt: null } });
  supportAggregate.mockResolvedValue({ _min: { dueAt: null } });
});

describe("loadOperationsOverview（anti-oracle 与 capability 门）", () => {
  it("O02：仅 report.review@A → 只执行 reports 聚合；campus B 与其余四域零查询", async () => {
    const summaries = await loadOperationsOverview({
      viewerId: VIEWER,
      reports: { global: false, campusIds: ["A"] },
      verifications: null,
      appeals: null,
      disputes: null,
      support: null,
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ domain: "reports", href: "/governance/reports" });

    // O02：campus B 不在任何查询谓词中（授权分支仅 exact pair A）
    const reportWhere = caseCount.mock.calls[0][0].where;
    expect(JSON.stringify(reportWhere)).toContain('"A"');
    expect(JSON.stringify(reportWhere)).not.toContain('"B"');
    expect(JSON.stringify(reportWhere)).not.toContain("UNSCOPED");

    // anti-oracle：无权限域的聚合查询结构性不执行
    expect(verificationCount).not.toHaveBeenCalled();
    expect(appealCount).not.toHaveBeenCalled();
    expect(disputeCount).not.toHaveBeenCalled();
    expect(supportCount).not.toHaveBeenCalled();
  });

  it("O03：仅 verification reviewer → 仅 verification 卡片（无 assignedToMe 字段）", async () => {
    verificationCount
      .mockResolvedValueOnce(3) // active（PENDING）
      .mockResolvedValueOnce(1); // overdue（PENDING ∧ reviewDueAt < now）
    verificationAggregate.mockResolvedValue({ _min: { reviewDueAt: new Date("2026-09-20T10:00:00Z") } });

    const summaries = await loadOperationsOverview({
      viewerId: VIEWER,
      reports: null,
      verifications: { global: true, campusIds: [] },
      appeals: null,
      disputes: null,
      support: null,
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      domain: "verifications",
      activeCount: 3,
      overdueCount: 1,
      oldestDueAt: "2026-09-20T10:00:00.000Z",
    });
    expect(summaries[0]!.assignedToMeCount).toBeUndefined();
    expect(caseCount).not.toHaveBeenCalled();
    expect(supportCount).not.toHaveBeenCalled();
  });

  it("O04/O05：GLOBAL support 看到 UNSCOPED + 全部校区；campus support agent 绝不见 UNSCOPED", async () => {
    await loadOperationsOverview({
      viewerId: VIEWER,
      reports: null,
      verifications: null,
      appeals: null,
      disputes: null,
      support: { global: true, campusIds: [] },
    });
    const globalScope = JSON.stringify(supportCount.mock.calls[0][0].where);
    expect(globalScope).toContain("UNSCOPED");
    expect(globalScope).toContain('"A"');
    expect(globalScope).toContain('"B"');

    supportCount.mockClear();
    await loadOperationsOverview({
      viewerId: VIEWER,
      reports: null,
      verifications: null,
      appeals: null,
      disputes: null,
      support: { global: false, campusIds: ["A"] },
    });
    const campusScope = JSON.stringify(supportCount.mock.calls[0][0].where);
    expect(campusScope).toContain('"A"');
    expect(campusScope).not.toContain("UNSCOPED");
    expect(campusScope).not.toContain('"B"');
  });

  it("O06：多 capability → 全部授权域卡片并集", async () => {
    const summaries = await loadOperationsOverview({
      viewerId: VIEWER,
      reports: { global: false, campusIds: ["A"] },
      verifications: null,
      appeals: { global: true, campusIds: [] },
      disputes: { global: false, campusIds: ["A"] },
      support: null,
    });

    expect(summaries.map((summary) => summary.domain)).toEqual([
      "reports",
      "appeals",
      "disputes",
    ]);
  });

  it("零有效 scope（capability 存在但 scope 空集）→ fail-closed 零聚合、零计数卡片", async () => {
    const summaries = await loadOperationsOverview({
      viewerId: VIEWER,
      reports: { global: false, campusIds: [] },
      verifications: null,
      appeals: null,
      disputes: { global: false, campusIds: [] },
      support: null,
    });

    // 空集 scope 返回 0 计数卡片（与队列空页同语义），但绝不执行聚合
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({ domain: "reports", activeCount: 0, overdueCount: 0 });
    expect(summaries[1]).toMatchObject({ domain: "disputes", activeCount: 0, overdueCount: 0 });
    expect(caseCount).not.toHaveBeenCalled();
    expect(caseAggregate).not.toHaveBeenCalled();
    expect(disputeCount).not.toHaveBeenCalled();
    expect(disputeAggregate).not.toHaveBeenCalled();
  });

  it("summary 仅 counts/timestamps（§6 合同字段）；assignedToMe 仅 assignment 域返回", async () => {
    caseCount.mockImplementation((input: { where: { AND: unknown[] } }) => {
      const serialized = JSON.stringify(input.where);
      if (serialized.includes("assignedToId")) return Promise.resolve(2);
      if (serialized.includes("dueAt")) return Promise.resolve(3);
      return Promise.resolve(7);
    });
    caseAggregate.mockResolvedValue({ _min: { dueAt: new Date("2026-09-21T08:00:00Z") } });

    const [summary] = await loadOperationsOverview({
      viewerId: VIEWER,
      reports: { global: true, campusIds: [] },
      verifications: null,
      appeals: null,
      disputes: null,
      support: null,
    });

    expect(summary).toEqual({
      domain: "reports",
      title: "举报处理",
      href: "/governance/reports",
      activeCount: 7,
      overdueCount: 3,
      assignedToMeCount: 2,
      oldestDueAt: "2026-09-21T08:00:00.000Z",
    });
  });
});
