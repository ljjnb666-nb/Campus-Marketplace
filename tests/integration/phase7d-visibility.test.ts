import { randomUUID } from "node:crypto";
import type { AuditReadAccess } from "@/lib/audit/audit-access";
import type { EnforcementReadAccess } from "@/lib/enforcement/enforcement-read-access";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phase 7D 审计/执法可见性读面集成测试（真实 PostgreSQL）。
 *
 * 覆盖（实现指令 §29/§30/§31）：
 * - 审计：GLOBAL/campus scope 矩阵（null 行仅 GLOBAL 读者可见）、同
 *   createdAt 的 id tiebreak 确定性 keyset 分页（零重叠零遗漏）、
 *   detail 永不出 DTO、metadata 读侧投影（指针/未知键丢弃）、日期过滤、
 *   R2 展示语义（NO_CAMPUS_SCOPE_RECORDED）；
 * - 执法：enforcementSeq DESC 队列 / ASC bounded 历史、createdAt 乱序不改
 *   因果序、单值 seq keyset 分页、legacy epoch + 溯源不完整徽标、scope
 *   分类（含不一致行 fail-closed fallback）、note/sourceId 结构性不暴露、
 *   bigint decimal wire、RiskState current summary（campus 谓词；显式
 *   NORMAL 行 = 状态证据）、注销 actor 安全 fallback；
 * - 目标存在性（T01..T10，T07 在组件层断言）：零 anchor → notFound 语义、
 *   RiskState/NORMAL 可作 anchor、跨校区/GLOBAL-only anchor 对 campus
 *   读者不建立存在性。
 *
 * 并行隔离：全部查询带 RUN_TAG 专用 fixture 谓词（actorId/targetId），
 * 与其他集成文件的行互不串扰；合成低段 enforcementSeq 取随机值避撞。
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p7d-vis-${randomUUID().slice(0, 8)}`;
const FIXTURE_PASSWORD_HASH = ["$2a$10$", "itfixtureitfixtureitfixtureitfixtureitfix"].join("");
// tests tsconfig target ES2017：BigInt 用构造器（沿 enforcement-sequence.ts 先例）
const LEGACY_SEQ = BigInt(900000000 + Math.floor(Math.random() * 99_000_000) + 1);

const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdAdminLogIds: string[] = [];
const createdEnforcementActionIds: string[] = [];
const createdRiskStateIds: string[] = [];

let campusA = "";
let campusB = "";
let logActorId = "";
let actorId = "";
let targetId = "";
let erasedActorId = "";
let plainUserId = "";
let riskOnlyTargetId = "";
let campusBTargetId = "";

describe.skipIf(!integrationDatabaseUrl)("Phase 7D 审计/执法可见性读面（真实 PostgreSQL）", () => {
  beforeAll(async () => {
    if (!rawClient) {
      return;
    }

    const campusARow = await rawClient.campus.create({
      data: { name: "7D校区A", slug: `${RUN_TAG}-a`, schoolName: "集成测试大学" },
    });
    const campusBRow = await rawClient.campus.create({
      data: { name: "7D校区B", slug: `${RUN_TAG}-b`, schoolName: "集成测试大学" },
    });
    createdCampusIds.push(campusARow.id, campusBRow.id);
    campusA = campusARow.id;
    campusB = campusBRow.id;

    async function createUser(name: string, overrides: Record<string, unknown> = {}) {
      const user = await rawClient!.user.create({
        data: {
          email: `${RUN_TAG}-${createdUserIds.length}@it.local`,
          name,
          passwordHash: FIXTURE_PASSWORD_HASH,
          schoolName: "集成测试大学",
          campusId: campusA,
          role: "STUDENT",
          ...overrides,
        },
      });
      createdUserIds.push(user.id);
      return user;
    }

    const logActor = await createUser("审计行操作员");
    logActorId = logActor.id;
    const actor = await createUser("执法执行者");
    actorId = actor.id;
    const target = await createUser("执法目标");
    targetId = target.id;
    const erased = await createUser("注销执行者", { erasedAt: new Date() });
    erasedActorId = erased.id;
    const plain = await createUser("零记录用户");
    plainUserId = plain.id;
    const riskOnly = await createUser("仅风险状态目标");
    riskOnlyTargetId = riskOnly.id;
    const campusBTarget = await createUser("B校区目标");
    campusBTargetId = campusBTarget.id;

    // ── AdminLog fixtures（全部挂在 logActorId 名下以便过滤隔离）────────
    const logRows = [
      { createdAt: new Date("2026-09-10T08:00:00.000Z"), campusId: null },
      { createdAt: new Date("2026-09-11T08:00:00.000Z"), campusId: campusA },
      { createdAt: new Date("2026-09-12T08:00:00.000Z"), campusId: campusB },
      // 同 createdAt 对（id tiebreak 确定性分页）
      { createdAt: new Date("2026-09-13T08:00:00.000Z"), campusId: null },
      { createdAt: new Date("2026-09-13T08:00:00.000Z"), campusId: null },
    ];
    for (const [index, row] of logRows.entries()) {
      const created = await rawClient!.adminLog.create({
        data: {
          adminId: logActorId,
          action: `FIXTURE_ACTION_${index}`,
          targetType: "USER",
          targetId,
          detail: "TOPSECRET-DETAIL-7D",
          campusId: row.campusId,
          createdAt: row.createdAt,
          metadata:
            index === 0
              ? { reasonCode: "FRAUD_CONFIRMED", targetUserId: "secret-pointer-7d", unknownKey: "drop-me" }
              : undefined,
        },
      });
      createdAdminLogIds.push(created.id);
    }

    // ── EnforcementAction fixtures ────────────────────────────────────────
    // seq 升序插入（默认 DB sequence），createdAt 刻意乱序：
    // seq 越大 createdAt 越早 → 队列必须仍按 seq DESC
    const ea1 = await rawClient!.enforcementAction.create({
      data: {
        type: "ACCOUNT_SUSPEND",
        actorId,
        targetId,
        campusId: null,
        scopeKey: "GLOBAL",
        reasonCode: "FRAUD_CONFIRMED",
        note: "internal-note-7d",
        sourceType: "REPORT",
        sourceId: "secret-source-7d",
        resultState: "USER:SUSPENDED",
        previousState: "USER:ACTIVE",
        createdAt: new Date("2026-09-12T08:00:00.000Z"),
      },
    });
    createdEnforcementActionIds.push(ea1.id);
    const ea2 = await rawClient!.enforcementAction.create({
      data: {
        type: "MARKETPLACE_RESTRICT",
        actorId,
        targetId,
        campusId: campusA,
        scopeKey: `CAMPUS:${campusA}`,
        reasonCode: "POLICY_VIOLATION",
        resultState: `RISK_STATE:RESTRICTED@CAMPUS:${campusA}`,
        previousState: "RISK_STATE:NORMAL",
        createdAt: new Date("2026-09-11T08:00:00.000Z"),
      },
    });
    createdEnforcementActionIds.push(ea2.id);
    const ea3 = await rawClient!.enforcementAction.create({
      data: {
        type: "MEMBERSHIP_SUSPEND",
        actorId,
        targetId,
        campusId: campusB,
        scopeKey: `CAMPUS:${campusB}`,
        reasonCode: "HARASSMENT_CONFIRMED",
        resultState: `CAMPUS_MEMBERSHIP:SUSPENDED@CAMPUS:${campusB}`,
        previousState: "CAMPUS_MEMBERSHIP:ACTIVE",
        createdAt: new Date("2026-09-10T08:00:00.000Z"),
      },
    });
    createdEnforcementActionIds.push(ea3.id);
    // 不一致行（fail-closed 展示）：scopeKey GLOBAL 但 campusId 非 null
    const ea4 = await rawClient!.enforcementAction.create({
      data: {
        type: "MARKETPLACE_RESTORE",
        actorId,
        targetId,
        campusId: campusA,
        scopeKey: "GLOBAL",
        reasonCode: "FALSE_POSITIVE_CORRECTION",
        resultState: "RISK_STATE:NORMAL",
        previousState: null,
        createdAt: new Date("2026-09-09T08:00:00.000Z"),
      },
    });
    createdEnforcementActionIds.push(ea4.id);
    // legacy epoch 行（显式低段 seq + previousState=null → 溯源不完整）
    const ea5 = await rawClient!.enforcementAction.create({
      data: {
        type: "ACCOUNT_REINSTATE",
        actorId,
        targetId,
        campusId: null,
        scopeKey: "GLOBAL",
        reasonCode: "MANUAL_REVIEW",
        resultState: "USER:ACTIVE",
        previousState: null,
        createdAt: new Date("2026-09-08T08:00:00.000Z"),
        enforcementSeq: LEGACY_SEQ,
      },
    });
    createdEnforcementActionIds.push(ea5.id);
    // campus B 目标的 GLOBAL-only anchor（T06）
    const ea6 = await rawClient!.enforcementAction.create({
      data: {
        type: "ACCOUNT_SUSPEND",
        actorId,
        targetId: campusBTargetId,
        campusId: null,
        scopeKey: "GLOBAL",
        reasonCode: "ACCOUNT_SECURITY",
        resultState: "USER:SUSPENDED",
        previousState: "USER:ACTIVE",
        createdAt: new Date("2026-09-07T08:00:00.000Z"),
      },
    });
    createdEnforcementActionIds.push(ea6.id);
    // 注销 actor 行（T08 hydration fallback）
    const ea7 = await rawClient!.enforcementAction.create({
      data: {
        type: "MARKETPLACE_RESTRICT",
        actorId: erasedActorId,
        targetId,
        campusId: null,
        scopeKey: "GLOBAL",
        reasonCode: "MANUAL_REVIEW",
        resultState: "RISK_STATE:WATCH",
        previousState: "RISK_STATE:NORMAL",
        createdAt: new Date("2026-09-06T08:00:00.000Z"),
      },
    });
    createdEnforcementActionIds.push(ea7.id);

    // ── RiskState fixtures（target：GLOBAL RESTRICTED + campusA 显式 NORMAL）──
    const rs1 = await rawClient!.riskState.create({
      data: {
        userId: targetId,
        campusId: null,
        scopeKey: "GLOBAL",
        state: "RESTRICTED",
        reasonCode: "FRAUD_CONFIRMED",
        updatedById: erasedActorId,
      },
    });
    createdRiskStateIds.push(rs1.id);
    const rs2 = await rawClient!.riskState.create({
      data: {
        userId: targetId,
        campusId: campusA,
        scopeKey: `CAMPUS:${campusA}`,
        state: "NORMAL",
        updatedById: actorId,
      },
    });
    createdRiskStateIds.push(rs2.id);
    // risk-only 目标：仅 campusA RiskState（T04 anchor）
    const rs3 = await rawClient!.riskState.create({
      data: {
        userId: riskOnlyTargetId,
        campusId: campusA,
        scopeKey: `CAMPUS:${campusA}`,
        state: "WATCH",
        reasonCode: "POLICY_VIOLATION",
      },
    });
    createdRiskStateIds.push(rs3.id);
  });

  afterAll(async () => {
    if (!rawClient) {
      return;
    }
    await rawClient.adminLog.deleteMany({ where: { id: { in: createdAdminLogIds } } });
    await rawClient.riskState.deleteMany({ where: { id: { in: createdRiskStateIds } } });
    await rawClient.enforcementAction.deleteMany({
      where: { id: { in: createdEnforcementActionIds } },
    });
    await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await rawClient.campus.deleteMany({ where: { id: { in: createdCampusIds } } });
    await rawClient.$disconnect();
  });

  // ── 审计（§29）───────────────────────────────────────────────────────────

  it("审计 scope 矩阵：GLOBAL 读者可见 null+campus 行；campus 读者仅本校区（null 不可见）", async () => {
    const { loadAuthorizedAuditPage } = await import("@/lib/audit/audit-read-model");

    const globalPage = await loadAuthorizedAuditPage({
      access: { global: true, campusIds: [] },
      limit: 50,
      filters: { actorId: logActorId },
    });
    const scopes = globalPage.items.map((item) => item.scope);
    expect(scopes).toContain("NO_CAMPUS_SCOPE_RECORDED");
    expect(scopes).toContain("CAMPUS");

    const campusAPage = await loadAuthorizedAuditPage({
      access: { global: false, campusIds: [campusA] },
      limit: 50,
      filters: { actorId: logActorId },
    });
    expect(campusAPage.items.length).toBeGreaterThan(0);
    for (const item of campusAPage.items) {
      expect(item.campusId).toBe(campusA);
      expect(item.scope).toBe("CAMPUS");
    }

    // 仅 null 行的读者视角（campus 集合为空集不可能；改以 campusB 验证互斥）
    const campusBPage = await loadAuthorizedAuditPage({
      access: { global: false, campusIds: [campusB] },
      limit: 50,
      filters: { actorId: logActorId },
    });
    expect(campusBPage.items.every((item) => item.campusId === campusB)).toBe(true);
    expect(campusBPage.items.some((item) => item.campusId === null)).toBe(false);
  });

  it("R2-01..03：null campus 行展示 NO_CAMPUS_SCOPE_RECORDED 语义（无编造校区/全局）", async () => {
    const { loadAuthorizedAuditPage } = await import("@/lib/audit/audit-read-model");

    const page = await loadAuthorizedAuditPage({
      access: { global: true, campusIds: [] },
      limit: 50,
      filters: { actorId: logActorId },
    });
    const nullRows = page.items.filter((item) => item.campusId === null);
    expect(nullRows.length).toBeGreaterThan(0);
    for (const row of nullRows) {
      expect(row.scope).toBe("NO_CAMPUS_SCOPE_RECORDED");
      expect(row.campusName).toBeNull();
    }
  });

  it("同 createdAt 行 id tiebreak：keyset 分页确定性、零重叠零遗漏", async () => {
    const { loadAuthorizedAuditPage } = await import("@/lib/audit/audit-read-model");
    const { decodeAuditCursor } = await import("@/validators/audit");
    const access: AuditReadAccess = { global: true, campusIds: [] };

    const collect = async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const result = await loadAuthorizedAuditPage({
          access,
          limit: 2,
          cursor: cursor ? decodeAuditCursor(cursor)! : undefined,
          filters: { actorId: logActorId },
        });
        seen.push(...result.items.map((item) => item.id));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return seen;
    };

    const firstRun = await collect();
    const secondRun = await collect();

    expect(firstRun).toHaveLength(5);
    expect(new Set(firstRun).size).toBe(5);
    expect(firstRun).toEqual(secondRun); // 同 createdAt → id DESC 确定性
  });

  it("最小化：AdminLog.detail 永不出 DTO；metadata 指针/未知键丢弃", async () => {
    const { loadAuthorizedAuditPage } = await import("@/lib/audit/audit-read-model");

    const page = await loadAuthorizedAuditPage({
      access: { global: true, campusIds: [] },
      limit: 50,
      filters: { actorId: logActorId },
    });

    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("TOPSECRET-DETAIL-7D");
    expect(serialized).not.toContain("secret-pointer-7d");
    expect(serialized).not.toContain("drop-me");
    for (const item of page.items) {
      expect(Object.keys(item)).not.toContain("detail");
    }
    const withMetadata = page.items.find((item) => item.metadata.length > 0);
    expect(withMetadata).toBeDefined();
    expect(withMetadata!.metadata).toEqual([
      { key: "reasonCode", label: "原因码", value: "FRAUD_CONFIRMED" },
    ]);
  });

  it("审计日期过滤：UTC 全天边界生效", async () => {
    const { loadAuthorizedAuditPage } = await import("@/lib/audit/audit-read-model");

    const page = await loadAuthorizedAuditPage({
      access: { global: true, campusIds: [] },
      limit: 50,
      filters: { actorId: logActorId, from: "2026-09-11", to: "2026-09-11" },
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].campusId).toBe(campusA);
  });

  // ── 执法（§30）───────────────────────────────────────────────────────────

  it("队列：enforcementSeq DESC 因果序；createdAt 乱序不影响；seq 为 decimal string", async () => {
    const { loadAuthorizedEnforcementQueue } = await import("@/lib/enforcement/enforcement-read-model");

    const page = await loadAuthorizedEnforcementQueue({
      access: { global: true, campusIds: [] },
      limit: 50,
      filters: { targetId },
    });

    // target 名下 6 行：ea1/ea2/ea3/ea4/ea5/ea7（ea6 属 campusBTarget，不在内）
    expect(page.items.length).toBe(6);
    const seqs = page.items.map((item) => BigInt(item.seq));
    for (let index = 1; index < seqs.length; index += 1) {
      expect(seqs[index - 1] > seqs[index]).toBe(true);
    }
    // createdAt 刻意与 seq 反序：seq 最大者 createdAt 最早（2026-09-06 erased 行）
    expect(page.items[0].createdAt).toBe("2026-09-06T08:00:00.000Z");
    expect(page.items[0].seq).toMatch(/^[0-9]+$/);
  });

  it("执法 scope 矩阵：campus A 读者按 campusId 列可见（CAMPUS 行 + 不一致行），GLOBAL/B 不可见", async () => {
    const { loadAuthorizedEnforcementQueue } = await import("@/lib/enforcement/enforcement-read-model");

    const page = await loadAuthorizedEnforcementQueue({
      access: { global: false, campusIds: [campusA] },
      limit: 50,
      filters: { targetId },
    });
    // campusId=campusA 的 target 行：ea2（CAMPUS:A）+ ea4（scopeKey GLOBAL 但 campusId=A）
    expect(page.items).toHaveLength(2);
    const classifications = page.items.map((item) => item.scope).sort();
    expect(classifications).toEqual(["CAMPUS", "SCOPE_INCONSISTENT"]);
    for (const item of page.items) {
      expect(item.campusId).toBe(campusA);
    }
  });

  it("scope 分类与徽标：不一致行 fail-closed fallback；legacy epoch + 溯源不完整", async () => {
    const { loadAuthorizedEnforcementQueue } = await import("@/lib/enforcement/enforcement-read-model");

    const page = await loadAuthorizedEnforcementQueue({
      access: { global: true, campusIds: [] },
      limit: 50,
      filters: { targetId },
    });

    const inconsistent = page.items.find((item) => item.scope === "SCOPE_INCONSISTENT");
    expect(inconsistent).toBeDefined();

    const legacy = page.items.find((item) => item.legacyEpoch);
    expect(legacy).toBeDefined();
    expect(legacy!.seq).toBe(LEGACY_SEQ.toString());
    expect(legacy!.provenanceComplete).toBe(false);

    const complete = page.items.find((item) => item.scope === "GLOBAL" && !item.legacyEpoch);
    expect(complete!.provenanceComplete).toBe(true);
  });

  it("最小化 + wire：note/sourceId 永不出 DTO；seq 可被 canonical 解码往返", async () => {
    const { loadAuthorizedEnforcementQueue } = await import("@/lib/enforcement/enforcement-read-model");
    const { decodeEnforcementSeqCursor, encodeEnforcementSeqCursor } = await import(
      "@/validators/enforcement"
    );

    const page = await loadAuthorizedEnforcementQueue({
      access: { global: true, campusIds: [] },
      limit: 50,
      filters: { targetId },
    });

    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("internal-note-7d");
    expect(serialized).not.toContain("secret-source-7d");
    for (const item of page.items) {
      expect(Object.keys(item)).not.toContain("note");
      expect(Object.keys(item)).not.toContain("sourceId");
      expect(Object.keys(item)).not.toContain("previousState");
      const decoded = decodeEnforcementSeqCursor(encodeEnforcementSeqCursor(BigInt(item.seq)));
      expect(decoded).toBe(BigInt(item.seq));
    }
  });

  it("队列单值 seq keyset 分页：零重叠零遗漏，末页 nextCursor=null", async () => {
    const { loadAuthorizedEnforcementQueue } = await import("@/lib/enforcement/enforcement-read-model");
    const { decodeEnforcementSeqCursor } = await import("@/validators/enforcement");
    const access: EnforcementReadAccess = { global: true, campusIds: [] };

    const seen: string[] = [];
    let cursor: bigint | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await loadAuthorizedEnforcementQueue({
        access,
        cursor,
        limit: 2,
        filters: { targetId },
      });
      seen.push(...result.items.map((item) => item.seq));
      if (!result.nextCursor) break;
      cursor = decodeEnforcementSeqCursor(result.nextCursor)!;
    }

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it("历史：enforcementSeq ASC bounded keyset（§20）", async () => {
    const { loadTargetEnforcementHistory } = await import("@/lib/enforcement/enforcement-read-model");

    const firstPage = await loadTargetEnforcementHistory({
      access: { global: true, campusIds: [] },
      targetId,
      limit: 2,
    });
    expect(firstPage.items).toHaveLength(2);
    expect(BigInt(firstPage.items[0].seq) < BigInt(firstPage.items[1].seq)).toBe(true);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await loadTargetEnforcementHistory({
      access: { global: true, campusIds: [] },
      targetId,
      cursor: BigInt(firstPage.items[1].seq),
      limit: 2,
    });
    const overlap = secondPage.items.filter((item) =>
      firstPage.items.some((first) => first.seq === item.seq),
    );
    expect(overlap).toHaveLength(0);
    expect(BigInt(secondPage.items[0].seq) > BigInt(firstPage.items[1].seq)).toBe(true);
  });

  it("RiskState current summary：campus 谓词；显式 NORMAL 行 = 状态证据；注销 updatedBy fallback", async () => {
    const { loadTargetRiskStateSummary } = await import("@/lib/enforcement/enforcement-read-model");

    const globalSummary = await loadTargetRiskStateSummary({
      access: { global: true, campusIds: [] },
      targetId,
    });
    expect(globalSummary).toHaveLength(2);
    const restricted = globalSummary.find((row) => row.state === "RESTRICTED");
    expect(restricted!.scopeKey).toBe("GLOBAL");
    expect(restricted!.updatedBy!.displayName).toBe("已注销用户");
    const normal = globalSummary.find((row) => row.state === "NORMAL");
    expect(normal!.campusId).toBe(campusA);

    const campusASummary = await loadTargetRiskStateSummary({
      access: { global: false, campusIds: [campusA] },
      targetId,
    });
    expect(campusASummary).toHaveLength(1);
    expect(campusASummary[0].state).toBe("NORMAL");

    const campusBSummary = await loadTargetRiskStateSummary({
      access: { global: false, campusIds: [campusB] },
      targetId,
    });
    expect(campusBSummary).toHaveLength(0);
  });

  it("T01/T02：零 anchor（存在的用户/不存在的 id）→ 同样 false（无存在性 oracle）", async () => {
    const { hasVisibleTargetAnchor } = await import("@/lib/enforcement/enforcement-read-model");

    expect(
      await hasVisibleTargetAnchor({ access: { global: true, campusIds: [] }, targetId: plainUserId }),
    ).toBe(false);
    expect(
      await hasVisibleTargetAnchor({
        access: { global: true, campusIds: [] },
        targetId: `${RUN_TAG}-ghost`,
      }),
    ).toBe(false);
  });

  it("T03/T04：enforcement anchor 与 RiskState（含显式 NORMAL）anchor 均可建立存在性", async () => {
    const { hasVisibleTargetAnchor } = await import("@/lib/enforcement/enforcement-read-model");

    expect(
      await hasVisibleTargetAnchor({ access: { global: true, campusIds: [] }, targetId }),
    ).toBe(true);
    expect(
      await hasVisibleTargetAnchor({
        access: { global: true, campusIds: [] },
        targetId: riskOnlyTargetId,
      }),
    ).toBe(true);
  });

  it("T05/T06：campus A 读者——仅跨校区 anchor 或 GLOBAL-only anchor → 不建立存在性", async () => {
    const { hasVisibleTargetAnchor } = await import("@/lib/enforcement/enforcement-read-model");
    const campusAAccess: EnforcementReadAccess = { global: false, campusIds: [campusA] };

    // campusBTarget 仅有 GLOBAL enforcement anchor → campus A 读者不可见
    expect(
      await hasVisibleTargetAnchor({ access: campusAAccess, targetId: campusBTargetId }),
    ).toBe(false);

    // riskOnly 目标仅 campusA RiskState → campus A 读者可见（对照）
    expect(
      await hasVisibleTargetAnchor({ access: campusAAccess, targetId: riskOnlyTargetId }),
    ).toBe(true);
  });

  it("T08/T09/T10：注销 actor 安全 fallback；DTO 无删除/隐私标志", async () => {
    const { loadAuthorizedEnforcementQueue } = await import("@/lib/enforcement/enforcement-read-model");

    const page = await loadAuthorizedEnforcementQueue({
      access: { global: true, campusIds: [] },
      limit: 50,
      filters: { targetId },
    });

    const erasedRow = page.items.find((item) => item.createdAt === "2026-09-06T08:00:00.000Z");
    expect(erasedRow).toBeDefined();
    expect(erasedRow!.actor.displayName).toBe("已注销用户");
    for (const item of page.items) {
      const keys = Object.keys(item);
      expect(keys).not.toContain("deletedAt");
      expect(keys).not.toContain("erasedAt");
    }
  });
});
