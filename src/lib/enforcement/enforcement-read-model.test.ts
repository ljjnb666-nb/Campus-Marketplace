import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockEnforcementFindMany,
  mockEnforcementFindFirst,
  mockRiskStateFindMany,
  mockRiskStateFindFirst,
  mockUserFindMany,
} = vi.hoisted(() => ({
  mockEnforcementFindMany: vi.fn(),
  mockEnforcementFindFirst: vi.fn(),
  mockRiskStateFindMany: vi.fn(),
  mockRiskStateFindFirst: vi.fn(),
  mockUserFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    enforcementAction: {
      findMany: mockEnforcementFindMany,
      findFirst: mockEnforcementFindFirst,
    },
    riskState: {
      findMany: mockRiskStateFindMany,
      findFirst: mockRiskStateFindFirst,
    },
    user: {
      findMany: mockUserFindMany,
    },
  },
}));

import {
  hasVisibleTargetAnchor,
  loadAuthorizedEnforcementQueue,
  loadTargetEnforcementHistory,
  loadTargetRiskStateSummary,
} from "@/lib/enforcement/enforcement-read-model";
import type { EnforcementReadAccess } from "@/lib/enforcement/enforcement-read-access";

const GLOBAL_ACCESS: EnforcementReadAccess = { global: true, campusIds: [] };
const CAMPUS_A_ACCESS: EnforcementReadAccess = { global: false, campusIds: ["A"] };
const ZERO_ACCESS: EnforcementReadAccess = { global: false, campusIds: [] };

function actionRow(overrides: Record<string, unknown> = {}) {
  return {
    enforcementSeq: BigInt(1000000003),
    type: "ACCOUNT_SUSPEND",
    campusId: null,
    campus: null,
    scopeKey: "GLOBAL",
    reasonCode: "FRAUD_CONFIRMED",
    sourceType: "REPORT",
    resultState: "USER:SUSPENDED",
    previousState: "USER:ACTIVE",
    createdAt: new Date("2026-09-15T08:00:00.000Z"),
    actorId: "actor-1",
    targetId: "target-1",
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of [
    mockEnforcementFindMany,
    mockEnforcementFindFirst,
    mockRiskStateFindMany,
    mockRiskStateFindFirst,
    mockUserFindMany,
  ]) {
    mock.mockReset();
  }
  mockUserFindMany.mockResolvedValue([]);
});

describe("loadAuthorizedEnforcementQueue（§17 冻结）", () => {
  it("零有效 scope → fail-closed 空页，不触达 DB", async () => {
    const page = await loadAuthorizedEnforcementQueue({ access: ZERO_ACCESS, limit: 25 });
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(mockEnforcementFindMany).not.toHaveBeenCalled();
  });

  it("GLOBAL 读者：无 scope 谓词；orderBy enforcementSeq DESC；take limit+1", async () => {
    mockEnforcementFindMany.mockResolvedValue([actionRow()]);

    const page = await loadAuthorizedEnforcementQueue({ access: GLOBAL_ACCESS, limit: 25 });

    const call = mockEnforcementFindMany.mock.calls[0][0];
    expect(call.where).toEqual({});
    expect(call.orderBy).toEqual([{ enforcementSeq: "desc" }]);
    expect(call.take).toBe(26);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("campus 读者：AND 恒含 exact-pair OR 谓词（FR01：campusId 与 scopeKey 成对，无 IN 叉积）", async () => {
    mockEnforcementFindMany.mockResolvedValue([]);

    await loadAuthorizedEnforcementQueue({
      access: { global: false, campusIds: ["A", "B"] },
      limit: 25,
    });

    const where = mockEnforcementFindMany.mock.calls[0][0].where;
    expect(where).toEqual({
      AND: [
        {
          OR: [
            { campusId: "A", scopeKey: "CAMPUS:A" },
            { campusId: "B", scopeKey: "CAMPUS:B" },
          ],
        },
      ],
    });
    // FR01-U：杜绝单列 IN 充当 scope 权威（避免 GLOBAL/A inconsistent 行可见）
    expect(JSON.stringify(where)).not.toContain('"in":');
  });

  it("seq 单值 keyset：cursor → enforcementSeq lt；过滤恒 AND", async () => {
    mockEnforcementFindMany.mockResolvedValue([]);

    await loadAuthorizedEnforcementQueue({
      access: GLOBAL_ACCESS,
      cursor: BigInt(1000000000),
      limit: 25,
      filters: { type: "ACCOUNT_SUSPEND", targetId: "t1" },
    });

    const conditions = mockEnforcementFindMany.mock.calls[0][0].where.AND;
    expect(conditions).toContainEqual({ enforcementSeq: { lt: BigInt(1000000000) } });
    expect(conditions).toContainEqual({ type: "ACCOUNT_SUSPEND" });
    expect(conditions).toContainEqual({ targetId: "t1" });
  });

  it("hasMore → 截断 + nextCursor 为 canonical decimal（R6 wire）", async () => {
    mockEnforcementFindMany.mockResolvedValue([
      actionRow({ enforcementSeq: BigInt(1000000005) }),
      actionRow({ enforcementSeq: BigInt(1000000004) }),
      actionRow({ enforcementSeq: BigInt(1000000003) }),
    ]);

    const page = await loadAuthorizedEnforcementQueue({ access: GLOBAL_ACCESS, limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.items[0].seq).toBe("1000000005");
    expect(page.nextCursor).toBe(
      Buffer.from("1000000004", "utf8").toString("base64url"),
    );
  });

  it("scope 分类：GLOBAL∧null=GLOBAL；CAMPUS:<id>∧一致=CAMPUS；不一致行 fail closed", async () => {
    mockEnforcementFindMany.mockResolvedValue([
      actionRow(),
      actionRow({ enforcementSeq: BigInt(1000000002), scopeKey: "CAMPUS:A", campusId: "A", campus: { name: "主校区" } }),
      actionRow({ enforcementSeq: BigInt(1000000001), scopeKey: "GLOBAL", campusId: "A" }),
      actionRow({ enforcementSeq: BigInt(1000000000), scopeKey: "CAMPUS:A", campusId: "B" }),
      actionRow({ enforcementSeq: BigInt(999999999), scopeKey: "WEIRD", campusId: null }),
    ]);

    const page = await loadAuthorizedEnforcementQueue({ access: GLOBAL_ACCESS, limit: 25 });

    expect(page.items.map((item) => item.scope)).toEqual([
      "GLOBAL",
      "CAMPUS",
      "SCOPE_INCONSISTENT",
      "SCOPE_INCONSISTENT",
      "SCOPE_INCONSISTENT",
    ]);
    expect(page.items[1].campusName).toBe("主校区");
    // legacy epoch badge：seq < 1e9
    expect(page.items[4].legacyEpoch).toBe(true);
    expect(page.items[0].legacyEpoch).toBe(false);
  });

  it("provenance/最小化：previousState 只折算为布尔；note/sourceId/原始 previousState 不出 DTO", async () => {
    mockEnforcementFindMany.mockResolvedValue([
      actionRow({ note: "operator internal note", sourceId: "report-123", previousState: null }),
    ]);

    const page = await loadAuthorizedEnforcementQueue({ access: GLOBAL_ACCESS, limit: 25 });

    const item = page.items[0];
    expect(item.provenanceComplete).toBe(false);
    expect(Object.keys(item).sort()).not.toContain("note");
    expect(Object.keys(item).sort()).not.toContain("sourceId");
    expect(Object.keys(item).sort()).not.toContain("previousState");
    expect(item.createdAt).toBe("2026-09-15T08:00:00.000Z");
  });

  it("select 结构性不含 note/sourceId；actor/target 走批量安全水合", async () => {
    mockEnforcementFindMany.mockResolvedValue([actionRow()]);
    mockUserFindMany.mockResolvedValue([
      { id: "actor-1", name: "执法员", deletedAt: null, erasedAt: null },
    ]);

    const page = await loadAuthorizedEnforcementQueue({ access: GLOBAL_ACCESS, limit: 25 });

    const select = mockEnforcementFindMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("note");
    expect(select).not.toHaveProperty("sourceId");
    expect(select).not.toHaveProperty("appeal");
    expect(mockUserFindMany.mock.calls[0][0].where).toEqual({ id: { in: ["actor-1", "target-1"] } });
    expect(page.items[0].actor.displayName).toBe("执法员");
    expect(page.items[0].target.displayName).toBe("已注销用户");
  });
});

describe("loadTargetEnforcementHistory（§20 冻结：bounded seq ASC）", () => {
  it("targetId 谓词 + seq gt cursor + asc 排序 + take limit+1", async () => {
    mockEnforcementFindMany.mockResolvedValue([]);

    await loadTargetEnforcementHistory({
      access: GLOBAL_ACCESS,
      targetId: "target-1",
      cursor: BigInt(1000000000),
      limit: 25,
    });

    const call = mockEnforcementFindMany.mock.calls[0][0];
    expect(call.where.AND).toContainEqual({ targetId: "target-1" });
    expect(call.where.AND).toContainEqual({ enforcementSeq: { gt: BigInt(1000000000) } });
    expect(call.orderBy).toEqual([{ enforcementSeq: "asc" }]);
    expect(call.take).toBe(26);
  });

  it("campus 读者：历史查询同样恒 AND exact-pair scope（FR01 统一谓词）", async () => {
    mockEnforcementFindMany.mockResolvedValue([]);

    await loadTargetEnforcementHistory({ access: CAMPUS_A_ACCESS, targetId: "t1", limit: 25 });

    expect(mockEnforcementFindMany.mock.calls[0][0].where.AND).toContainEqual({
      OR: [{ campusId: "A", scopeKey: "CAMPUS:A" }],
    });
    expect(JSON.stringify(mockEnforcementFindMany.mock.calls[0][0].where)).not.toContain('"in":');
  });

  it("zero scope → fail-closed 空页", async () => {
    const page = await loadTargetEnforcementHistory({
      access: ZERO_ACCESS,
      targetId: "t1",
      limit: 25,
    });
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(mockEnforcementFindMany).not.toHaveBeenCalled();
  });
});

describe("loadTargetRiskStateSummary（DECISION_05/06：current summary，不考古）", () => {
  it("GLOBAL：返回 summary；NORMAL 显式行本身是状态证据照常返回；updatedBy 水合 null-safe", async () => {
    mockRiskStateFindMany.mockResolvedValue([
      {
        scopeKey: "GLOBAL",
        campusId: null,
        campus: null,
        state: "RESTRICTED",
        reasonCode: "FRAUD_CONFIRMED",
        updatedById: "actor-1",
        updatedAt: new Date("2026-09-15T09:00:00.000Z"),
      },
      {
        scopeKey: "CAMPUS:A",
        campusId: "A",
        campus: { name: "主校区" },
        state: "NORMAL",
        reasonCode: null,
        updatedById: null,
        updatedAt: new Date("2026-09-14T09:00:00.000Z"),
      },
    ]);
    mockUserFindMany.mockResolvedValue([
      { id: "actor-1", name: "操作员", deletedAt: null, erasedAt: null },
    ]);

    const summary = await loadTargetRiskStateSummary({ access: GLOBAL_ACCESS, targetId: "t1" });

    expect(mockRiskStateFindMany.mock.calls[0][0].where).toEqual({
      AND: [{ userId: "t1" }],
    });
    expect(summary).toHaveLength(2);
    expect(summary[0].state).toBe("RESTRICTED");
    expect(summary[0].updatedBy).toEqual({ id: "actor-1", displayName: "操作员" });
    expect(summary[1].state).toBe("NORMAL");
    expect(summary[1].updatedBy).toBeNull();
  });

  it("campus 读者：恒含 campusId IN 谓词（GLOBAL RiskState 行不可见）", async () => {
    mockRiskStateFindMany.mockResolvedValue([]);

    await loadTargetRiskStateSummary({ access: CAMPUS_A_ACCESS, targetId: "t1" });

    expect(mockRiskStateFindMany.mock.calls[0][0].where).toEqual({
      AND: [{ userId: "t1" }, { campusId: { in: ["A"] } }],
    });
  });

  it("zero scope → 空数组不触达 DB；RiskFlag 结构性不进入本模型", async () => {
    const summary = await loadTargetRiskStateSummary({ access: ZERO_ACCESS, targetId: "t1" });
    expect(summary).toEqual([]);
    expect(mockRiskStateFindMany).not.toHaveBeenCalled();
  });
});

describe("hasVisibleTargetAnchor（R5 / DECISION_13 存在性权威）", () => {
  it("enforcement anchor 命中 → true（不再查 RiskState）", async () => {
    mockEnforcementFindFirst.mockResolvedValue({ id: "ea-1" });

    expect(await hasVisibleTargetAnchor({ access: GLOBAL_ACCESS, targetId: "t1" })).toBe(true);
    expect(mockEnforcementFindFirst.mock.calls[0][0].where.targetId).toBe("t1");
    expect(mockRiskStateFindFirst).not.toHaveBeenCalled();
  });

  it("RiskState（含 NORMAL 行）anchor 命中 → true", async () => {
    mockEnforcementFindFirst.mockResolvedValue(null);
    mockRiskStateFindFirst.mockResolvedValue({ id: "rs-1" });

    expect(await hasVisibleTargetAnchor({ access: GLOBAL_ACCESS, targetId: "t1" })).toBe(true);
  });

  it("零 anchor → false（user 存在与否无关；不合成 NORMAL）", async () => {
    mockEnforcementFindFirst.mockResolvedValue(null);
    mockRiskStateFindFirst.mockResolvedValue(null);

    expect(await hasVisibleTargetAnchor({ access: GLOBAL_ACCESS, targetId: "t1" })).toBe(false);
  });

  it("campus 读者：anchor 查询恒含 exact-pair scope 谓词（GLOBAL-only/inconsistent anchor 不可建立存在性）", async () => {
    mockEnforcementFindFirst.mockResolvedValue(null);
    mockRiskStateFindFirst.mockResolvedValue(null);

    expect(await hasVisibleTargetAnchor({ access: CAMPUS_A_ACCESS, targetId: "t1" })).toBe(false);

    // EnforcementAction anchor：exact pair（FR01）
    expect(mockEnforcementFindFirst.mock.calls[0][0].where).toEqual({
      targetId: "t1",
      AND: [{ OR: [{ campusId: "A", scopeKey: "CAMPUS:A" }] }],
    });
    // RiskState anchor：沿用已冻结的 campusId 可见性模型（本轮不改）
    expect(mockRiskStateFindFirst.mock.calls[0][0].where).toEqual({
      userId: "t1",
      AND: [{ campusId: { in: ["A"] } }],
    });
  });

  it("FR01-U-anchor：inconsistent GLOBAL/A 行不满足 exact pair → campus 读者不可 anchor", async () => {
    // scopeKey=GLOBAL + campusId=A 的行：exact pair (A, CAMPUS:A) 结构性不命中
    mockEnforcementFindFirst.mockResolvedValue(null);
    mockRiskStateFindFirst.mockResolvedValue(null);

    await hasVisibleTargetAnchor({ access: CAMPUS_A_ACCESS, targetId: "inconsistent-only" });

    const where = mockEnforcementFindFirst.mock.calls[0][0].where;
    expect(where).toEqual({
      targetId: "inconsistent-only",
      AND: [{ OR: [{ campusId: "A", scopeKey: "CAMPUS:A" }] }],
    });
  });

  it("zero scope → false 不触达 DB", async () => {
    expect(await hasVisibleTargetAnchor({ access: ZERO_ACCESS, targetId: "t1" })).toBe(false);
    expect(mockEnforcementFindFirst).not.toHaveBeenCalled();
  });
});
