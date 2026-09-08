import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phase 6C-1A Enforcement Provenance 集成测试（真实 PostgreSQL）。
 *
 * 覆盖：
 *  1. sequence/column 数据库合同：CACHE 1 / START 1e9 / OWNED BY / NOT NULL /
 *     UNIQUE / previousState 保持 nullable（rollback 兼容，绝不自动 ALTER 修正）
 *  2. REQUIRED RACE：真实 PG transaction timestamp 反转 —— Tx B 先开事务捕获
 *     transaction timestamp（barrier 在 target subject lock 之前），Tx A 随后
 *     完成完整 ACCOUNT_SUSPEND；释放 B 后 B 完成完整 ACCOUNT_REINSTATE。
 *     断言 B.createdAt <= A.createdAt（相等亦 PASS）同时 A.seq < B.seq ——
 *     createdAt 不是因果序，enforcementSeq 才是。
 *  3. sequence 唯一性（多 target 并行）+ rollback 烧号 gap（禁止 gapless 断言）
 *  4. 两维正交分类：PRE_MIGRATION_LEGACY / NORMAL AUTHORITATIVE / ROLLBACK_COMPAT
 *  5. latestSameFamily：最高 seq 胜出（createdAt 不参与）；跨 scope 不 supersede；
 *     ROLLBACK_COMPAT（previousState=null）可正常成为 latest
 *  6. previousState 六类矩阵（真实 service 产生，精确匹配 transition 编码）
 *  7. upgrade migration：pre-6C schema + 既有 EA 行 → 应用新迁移 →
 *     旧行 previousState=null、seq ∈ (0, boundary)；新写入 seq >= boundary
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const prisma = integrationDatabaseUrl ? (await import("@/lib/prisma")).prisma : null;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p6c1a-${randomUUID().slice(0, 8)}`;
const NEW_MIGRATION = "20260908120000_phase6c_enforcement_provenance";
const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdRoleIds: string[] = [];

/** 合成 seq 值（远离 dev 库 backfill 1..N 与 sequence 起点；各测试值段互不重叠——
 * unique 索引是全表级的）。同一值段重复运行前先按 seq 清理孤儿行（beforeAll）。
 * 用 BigInt(...) 而非字面量：仓库 TS target ES2017 不支持 BigInt 字面量。 */
const BOUNDARY = BigInt(1_000_000_000);
const SYNTHETIC_LEGACY_SEQ = BOUNDARY - BigInt(2);
const SYNTHETIC_CLASSIFY_AUTH_SEQ = BOUNDARY + BigInt(5_000_000);
const SYNTHETIC_CLASSIFY_ROLLBACK_COMPAT_SEQ = BOUNDARY + BigInt(5_000_002);
const SYNTHETIC_LATEST_R1_SEQ = BOUNDARY + BigInt(6_000_001);
const SYNTHETIC_LATEST_R2_SEQ = BOUNDARY + BigInt(6_000_000);
const SYNTHETIC_LATEST_R3_SEQ = BOUNDARY + BigInt(6_000_002);
const SYNTHETIC_LATEST_CA_SEQ = BOUNDARY + BigInt(6_000_003);
const SYNTHETIC_LATEST_CB_SEQ = BOUNDARY + BigInt(6_000_004);
const ALL_SYNTHETIC_SEQS = [
  SYNTHETIC_LEGACY_SEQ,
  SYNTHETIC_CLASSIFY_AUTH_SEQ,
  SYNTHETIC_CLASSIFY_ROLLBACK_COMPAT_SEQ,
  SYNTHETIC_LATEST_R1_SEQ,
  SYNTHETIC_LATEST_R2_SEQ,
  SYNTHETIC_LATEST_R3_SEQ,
  SYNTHETIC_LATEST_CA_SEQ,
  SYNTHETIC_LATEST_CB_SEQ,
];

async function createFixtureCampus(name: string) {
  const campus = await rawClient!.campus.create({
    data: { name, slug: `${RUN_TAG}-${name}`, schoolName: "集成测试大学" },
  });
  createdCampusIds.push(campus.id);
  return campus;
}

async function createFixtureUser(
  name: string,
  campusId: string,
  options: { role?: "STUDENT" | "ADMIN"; status?: "ACTIVE" | "SUSPENDED" } = {},
) {
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${createdUserIds.length}@it.local`,
      name,
      passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
      schoolName: "集成测试大学",
      campusId,
      role: options.role ?? "STUDENT",
      status: options.status ?? "ACTIVE",
    },
  });
  createdUserIds.push(user.id);
  await rawClient!.campusMembership.create({
    data: { userId: user.id, campusId, status: "ACTIVE" },
  });
  return user;
}

async function grantRole(
  userId: string,
  roleKey: string,
  permissionKeys: string[],
  scope: "GLOBAL" | "CAMPUS",
  campusId?: string,
) {
  const role = await rawClient!.role.create({
    data: {
      key: `${RUN_TAG}-${roleKey}`,
      name: roleKey,
      scope,
      isSystem: false,
      rolePermissions: {
        create: permissionKeys.map((key) => ({ permission: { connect: { key } } })),
      },
    },
  });
  createdRoleIds.push(role.id);
  await rawClient!.userRoleAssignment.create({
    data: {
      userId,
      roleId: role.id,
      campusId: campusId ?? null,
      scopeKey: scope === "GLOBAL" ? "GLOBAL" : `CAMPUS:${campusId}`,
    },
  });
  return role;
}

/** 直插 EA 行（合成 seq / 自选 createdAt），用于分类与 latest 排序验证 */
async function insertRawAction(data: {
  id: string;
  type: string;
  actorId: string;
  targetId: string;
  campusId?: string | null;
  scopeKey: string;
  previousState: string | null;
  resultState: string;
  enforcementSeq: bigint;
  createdAt: Date;
}) {
  await rawClient!.$executeRawUnsafe(
    `INSERT INTO "EnforcementAction"
       ("id", "type", "actorId", "targetId", "campusId", "scopeKey", "reasonCode",
        "note", "sourceType", "sourceId", "previousState", "resultState",
        "enforcementSeq", "createdAt")
     VALUES ('${data.id}', '${data.type}', '${data.actorId}', '${data.targetId}',
             ${data.campusId ? `'${data.campusId}'` : "NULL"}, '${data.scopeKey}',
             'MANUAL_REVIEW', NULL, NULL, NULL,
             ${data.previousState ? `'${data.previousState}'` : "NULL"},
             '${data.resultState}', ${data.enforcementSeq},
             '${data.createdAt.toISOString()}')`,
  );
}

function runPrismaDbExecute(sql: string, databaseUrl: string): void {
  execSync("npx prisma db execute --schema prisma/schema.prisma --stdin", {
    input: sql,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: ["pipe", "ignore", "pipe"],
  });
}

function swapDatabaseName(databaseUrl: string, name: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${name}`;
  parsed.search = "";
  return parsed.toString();
}

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 6C-1A enforcement provenance 集成测试（真实 PostgreSQL）",
  () => {
    let campusA: { id: string };
    let globalAdmin: { id: string };
    let secondAdmin: { id: string };
    let campusManager: { id: string };

    beforeAll(async () => {
      // 清理上次运行（如中途崩溃）遗留的合成 seq 行，保证合成值段可重入
      await rawClient!.enforcementAction.deleteMany({
        where: { enforcementSeq: { in: ALL_SYNTHETIC_SEQS } },
      });

      campusA = await createFixtureCampus("campus-a");
      globalAdmin = await createFixtureUser("全局管理员", campusA.id, { role: "ADMIN" });
      secondAdmin = await createFixtureUser("第二管理员", campusA.id, { role: "ADMIN" });
      campusManager = await createFixtureUser("校区经理", campusA.id);
      await grantRole(globalAdmin.id, "SUSPENDER_GLOBAL", ["user.suspend"], "GLOBAL");
      await grantRole(secondAdmin.id, "SUSPENDER_GLOBAL_B", ["user.suspend"], "GLOBAL");
      await grantRole(
        campusManager.id,
        "CAMPUS_MANAGER_P6C",
        ["campus.manage"],
        "CAMPUS",
        campusA.id,
      );

      const { ensureRbacFoundation, syncLegacyAdminRoles, ensureCampusMemberships } =
        await import("@/lib/rbac/bootstrap");
      await ensureRbacFoundation(prisma!);
      await syncLegacyAdminRoles(prisma!);
      await ensureCampusMemberships(prisma!);
    });

    afterAll(async () => {
      await rawClient!.enforcementAction.deleteMany({ where: { targetId: { in: createdUserIds } } });
      await rawClient!.riskFlag.deleteMany({ where: { userId: { in: createdUserIds } } });
      await rawClient!.riskState.deleteMany({ where: { userId: { in: createdUserIds } } });
      await rawClient!.campusMembership.deleteMany({ where: { userId: { in: createdUserIds } } });
      await rawClient!.userRoleAssignment.deleteMany({ where: { userId: { in: createdUserIds } } });
      await rawClient!.rolePermission.deleteMany({ where: { roleId: { in: createdRoleIds } } });
      await rawClient!.role.deleteMany({ where: { id: { in: createdRoleIds } } });
      await rawClient!.adminLog.deleteMany({ where: { adminId: { in: createdUserIds } } });
      await rawClient!.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
      await rawClient!.user.deleteMany({ where: { id: { in: createdUserIds } } });
      await rawClient!.campus.deleteMany({ where: { id: { in: createdCampusIds } } });
      await rawClient!.$disconnect();
      await prisma?.$disconnect();
    });

    // ------------------------------------------------------------------
    // 1. sequence / column 数据库合同（CACHE 1 DB gate）
    // ------------------------------------------------------------------

    it("enforcementSeq 数据库合同：CACHE 1 / START 1e9 / OWNED BY / NOT NULL / UNIQUE", async () => {
      const sequences = await rawClient!.$queryRaw<
        { sequencename: string; start_value: bigint; increment_by: bigint; cache_size: number }[]
      >`SELECT sequencename, start_value, increment_by, cache_size::int AS "cache_size"
         FROM pg_sequences
         WHERE schemaname = 'public' AND sequencename = 'EnforcementAction_enforcementSeq_seq'`;

      expect(sequences).toHaveLength(1);
      const sequence = sequences[0]!;
      // CACHE 1 gate：非 1 即 FAIL，测试绝不自动 ALTER SEQUENCE 修正环境
      expect(sequence.cache_size).toBe(1);
      expect(sequence.start_value).toBe(BOUNDARY);
      expect(sequence.increment_by).toBe(BigInt(1));

      const ownership = await rawClient!.$queryRaw<
        { table_name: string; column_name: string }[]
      >`SELECT tbl.relname AS table_name, att.attname AS column_name
         FROM pg_class seq
         JOIN pg_namespace ns ON ns.oid = seq.relnamespace
         JOIN pg_depend dep ON dep.objid = seq.oid AND dep.deptype = 'a'
         JOIN pg_class tbl ON tbl.oid = dep.refobjid
         JOIN pg_attribute att ON att.attrelid = dep.refobjid AND att.attnum = dep.refobjsubid
         WHERE ns.nspname = 'public' AND seq.relname = 'EnforcementAction_enforcementSeq_seq'`;

      expect(ownership).toEqual([{ table_name: "EnforcementAction", column_name: "enforcementSeq" }]);

      const columns = await rawClient!.$queryRaw<
        { column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
      >`SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'EnforcementAction'
           AND column_name IN ('enforcementSeq', 'previousState')
         ORDER BY column_name`;

      const seqColumn = columns.find((c) => c.column_name === "enforcementSeq")!;
      expect(seqColumn.data_type).toBe("bigint");
      expect(seqColumn.is_nullable).toBe("NO");
      expect(seqColumn.column_default).toContain("nextval");

      // rollback 兼容：previousState 保持 nullable（旧 image 仍可写 EA）
      const previousColumn = columns.find((c) => c.column_name === "previousState")!;
      expect(previousColumn.data_type).toBe("text");
      expect(previousColumn.is_nullable).toBe("YES");

      const uniqueIndexes = await rawClient!.$queryRaw<{ index_name: string }[]>
      `SELECT ix.relname AS index_name
         FROM pg_index i
         JOIN pg_class t ON t.oid = i.indrelid
         JOIN pg_class ix ON ix.oid = i.indexrelid
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (i.indkey)
         WHERE t.relname = 'EnforcementAction' AND i.indisunique AND a.attname = 'enforcementSeq'`;

      expect(uniqueIndexes.length).toBeGreaterThanOrEqual(1);
    });

    // ------------------------------------------------------------------
    // 2. 真实 PG transaction timestamp 反转（REQUIRED RACE）
    // ------------------------------------------------------------------

    it("timestamp 反转：B 先开事务（DB 默认 createdAt 更早）晚提交，因果序仍由 enforcementSeq 决定", async () => {
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      const { acquireGovernanceSubjectLocks } = await import("@/lib/governance/governance-lock");

      const target = await createFixtureUser("反转目标", campusA.id);

      let captureBStarted!: () => void;
      const bStarted = new Promise<void>((resolve) => {
        captureBStarted = resolve;
      });
      let releaseB!: () => void;
      const gateB = new Promise<void>((resolve) => {
        releaseB = resolve;
      });

      // ---- Tx B：先开事务并捕获 transaction timestamp，barrier 在 target 锁之前 ----
      // 注：Prisma create 对 @default(now()) 走客户端填充（语句墙钟时间）；
      // 要拿到「真实 PostgreSQL database default timestamp」（事务开始时间，
      // DEFAULT CURRENT_TIMESTAMP），EA INSERT 必须经 raw SQL 省略 createdAt 列。
      const txBPromise = rawClient!
        .$transaction(
          async (tx) => {
            // 事务第一条语句：捕获 transaction timestamp（事务开始即冻结，
            // 与 DEFAULT CURRENT_TIMESTAMP 同源）
            const nowRows = await tx.$queryRaw<{ tx_start: string }[]>
            `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS tx_start`;
            const bTxStart = nowRows[0]!.tx_start;
            captureBStarted();
            // barrier：等 A 完整提交后才继续（此时 B 尚未持有任何 subject 锁）
            await gateB;

            await acquireGovernanceSubjectLocks(tx, [
              { subjectType: "USER", subjectId: secondAdmin.id },
              { subjectType: "USER", subjectId: target.id },
            ]);

            // ACCOUNT_REINSTATE：operational mutation（SUSPENDED → ACTIVE）
            await tx.user.update({
              where: { id: target.id },
              data: { status: "ACTIVE" },
            });

            // 真实 EA 行：raw INSERT 省略 createdAt → DB default
            // （CURRENT_TIMESTAMP = B 的事务开始时间，早于 A）
            await tx.$executeRaw`INSERT INTO "EnforcementAction"
              ("id","type","actorId","targetId","campusId","scopeKey","reasonCode",
               "note","sourceType","sourceId","previousState","resultState")
             VALUES ('${RUN_TAG}-invert-B', 'ACCOUNT_REINSTATE', ${secondAdmin.id}, ${target.id},
                     NULL, 'GLOBAL', 'FALSE_POSITIVE_CORRECTION', NULL, NULL, NULL,
                     'USER:SUSPENDED', 'USER:ACTIVE')`;

            return bTxStart;
          },
          { maxWait: 30_000, timeout: 60_000 },
        )
        .then(
          (value) => ({ fulfilled: true as const, value }),
          (error) => ({
            fulfilled: false as const,
            value: undefined as string | undefined,
            error,
          }),
        );

      await bStarted;

      // ---- Tx A：完整 ACCOUNT_SUSPEND（真实 service，含 subject 锁 + EA + 审计）----
      const suspended = await suspendAccount({
        actorId: globalAdmin.id,
        targetUserId: target.id,
        reasonCode: "ACCOUNT_SECURITY",
      });
      expect(suspended).toMatchObject({ status: "SUSPENDED", alreadyInState: false });

      // ---- 释放 B：B 取同一 target 锁 → 完整 REINSTATE → EA B → commit ----
      releaseB();
      const txBResult = await txBPromise;
      expect(txBResult.fulfilled).toBe(true);

      // ---- 断言：两边都产生了真实 EA ----
      const actions = await rawClient!.enforcementAction.findMany({
        where: { targetId: target.id },
        orderBy: { enforcementSeq: "asc" },
      });
      expect(actions).toHaveLength(2);

      const [first, second] = actions;
      expect(first!.type).toBe("ACCOUNT_SUSPEND");
      expect(second!.type).toBe("ACCOUNT_REINSTATE");

      // 因果序：A linearized before B ⇔ seq(A) < seq(B)
      expect(first!.enforcementSeq < second!.enforcementSeq).toBe(true);

      // createdAt 反转（wall-clock audit 视角）：B 的 DB 事务时间戳 <= A 的行时间
      // （相等同样 PASS——equal timestamps cannot define strict causal order）
      expect(second!.createdAt.getTime()).toBeLessThanOrEqual(first!.createdAt.getTime());

      // B 的 createdAt 确实来自真实 DB 事务默认时间戳（= B 开事务时捕获的值；
      // to_char 的 MS 按微秒截断而 TIMESTAMP(3) 落盘四舍五入，允许 1ms 取整差）
      expect(txBResult.fulfilled).toBe(true);
      expect(
        Math.abs(second!.createdAt.getTime() - Date.parse(txBResult.value!)),
      ).toBeLessThanOrEqual(1);

      // 两行都是权威行：post-migration epoch + 完整反转溯源
      const { isCausallyOrdered, hasCompleteReversalProvenance, isAutoReversible } = await import(
        "@/lib/enforcement/enforcement-sequence"
      );
      for (const action of actions) {
        expect(isCausallyOrdered(action)).toBe(true);
        expect(hasCompleteReversalProvenance(action)).toBe(true);
        expect(isAutoReversible(action)).toBe(true);
      }
      expect(first!.previousState).toBe("USER:ACTIVE");
      expect(second!.previousState).toBe("USER:SUSPENDED");
    });

    // ------------------------------------------------------------------
    // 3. sequence 唯一性 + rollback 烧号 gap
    // ------------------------------------------------------------------

    it("多 target 并行 action：seq 全唯一", async () => {
      const { setRiskState } = await import("@/lib/enforcement/risk-service");

      // fixture 顺序创建（email 唯一性依赖 createdUserIds.length，禁并行），
      // 仅 6 个执法动作本身并行（distinct actor+target，无共享锁）
      const pairs = [];
      for (let index = 0; index < 6; index += 1) {
        const actor = await createFixtureUser(`并行管理员${index}`, campusA.id);
        const parallelTarget = await createFixtureUser(`并行目标${index}`, campusA.id);
        await grantRole(actor.id, `SUSPENDER_P${index}`, ["user.suspend"], "GLOBAL");
        pairs.push({ actor, parallelTarget });
      }

      await Promise.all(
        pairs.map(({ actor, parallelTarget }) =>
          setRiskState({
            actorId: actor.id,
            targetUserId: parallelTarget.id,
            campusId: null,
            state: "RESTRICTED",
            reasonCode: "POLICY_VIOLATION",
          }),
        ),
      );

      const actions = await rawClient!.enforcementAction.findMany({
        where: { targetId: { in: pairs.map((p) => p.parallelTarget.id) } },
        select: { enforcementSeq: true },
      });
      expect(actions).toHaveLength(6);
      const seqs = actions.map((a) => a.enforcementSeq);
      expect(new Set(seqs.map((s) => s.toString())).size).toBe(6);
      for (const seq of seqs) {
        expect(seq >= BOUNDARY).toBe(true);
      }
    }, 60_000);

    it("rollback 烧号产生 gap（VALID），后续 action 仍正常排序", async () => {
      const { setRiskState, setRiskStateTxLocked } = await import("@/lib/enforcement/risk-service");

      const target = await createFixtureUser("烧号目标", campusA.id);

      const sequenceLastValue = async (): Promise<bigint> => {
        const rows = await rawClient!.$queryRaw<{ last_value: bigint | null }[]>
        `SELECT last_value FROM "EnforcementAction_enforcementSeq_seq"`;
        return rows[0]!.last_value ?? BigInt(0);
      };

      const beforeBurn = await sequenceLastValue();

      // rollback：TxLocked seam 完成 EA INSERT 后事务故意回滚 → 烧掉一个 seq
      let rollbackObserved = false;
      try {
        await rawClient!.$transaction(
          async (tx) => {
            await setRiskStateTxLocked(tx, {
              actorId: globalAdmin.id,
              targetUserId: target.id,
              campusId: null,
              state: "RESTRICTED",
              reasonCode: "POLICY_VIOLATION",
            });
            throw new Error("deliberate-rollback-burn");
          },
          { maxWait: 30_000, timeout: 30_000 },
        );
      } catch {
        rollbackObserved = true;
      }
      expect(rollbackObserved).toBe(true);

      const afterBurn = await sequenceLastValue();
      // sequence 分配是非事务性的：rollback 后 last_value 已前进（烧号）
      expect(afterBurn > beforeBurn).toBe(true);

      // 后续成功 action：拿到全新 seq（> 烧号后的 last_value），正常参与排序
      const result = await setRiskState({
        actorId: globalAdmin.id,
        targetUserId: target.id,
        campusId: null,
        state: "RESTRICTED",
        reasonCode: "POLICY_VIOLATION",
      });
      expect(result.changed).toBe(true);

      const committed = await rawClient!.enforcementAction.findFirstOrThrow({
        where: { targetId: target.id },
        orderBy: { enforcementSeq: "desc" },
      });
      expect(committed.enforcementSeq > afterBurn).toBe(true);
      expect(committed.enforcementSeq >= BOUNDARY).toBe(true);

      // gap 之后 latest 解析仍然正确（只比较 MAX，禁止 gapless 断言）
      const { latestSameFamilyAction } = await import("@/lib/enforcement/enforcement-sequence");
      const { withTransaction } = await import("@/lib/prisma");
      const latest = await withTransaction((tx) =>
        latestSameFamilyAction(tx, {
          targetId: target.id,
          scopeKey: "GLOBAL",
          type: "MARKETPLACE_RESTRICT",
        }),
      );
      expect(latest?.id).toBe(committed.id);
    });

    // ------------------------------------------------------------------
    // 4. 两维正交分类（真实 DB 行）
    // ------------------------------------------------------------------

    it("分类：PRE_MIGRATION_LEGACY / NORMAL AUTHORITATIVE / ROLLBACK_COMPAT", async () => {
      const { isPreMigrationLegacy, isCausallyOrdered, hasCompleteReversalProvenance, isAutoReversible } =
        await import("@/lib/enforcement/enforcement-sequence");

      const actor = await createFixtureUser("分类管理员", campusA.id);
      const target = await createFixtureUser("分类目标", campusA.id);

      await insertRawAction({
        id: `${RUN_TAG}-legacy-1`,
        type: "ACCOUNT_SUSPEND",
        actorId: actor.id,
        targetId: target.id,
        campusId: null,
        scopeKey: "GLOBAL",
        previousState: null,
        resultState: "USER:SUSPENDED",
        enforcementSeq: SYNTHETIC_LEGACY_SEQ,
        createdAt: new Date("2026-09-01T00:00:00Z"),
      });
      await insertRawAction({
        id: `${RUN_TAG}-auth-1`,
        type: "ACCOUNT_REINSTATE",
        actorId: actor.id,
        targetId: target.id,
        campusId: null,
        scopeKey: "GLOBAL",
        previousState: "USER:SUSPENDED",
        resultState: "USER:ACTIVE",
        enforcementSeq: SYNTHETIC_CLASSIFY_AUTH_SEQ,
        createdAt: new Date("2026-09-01T01:00:00Z"),
      });
      await insertRawAction({
        id: `${RUN_TAG}-rollback-compat-1`,
        type: "ACCOUNT_SUSPEND",
        actorId: actor.id,
        targetId: target.id,
        campusId: null,
        scopeKey: "GLOBAL",
        previousState: null,
        resultState: "USER:SUSPENDED",
        enforcementSeq: SYNTHETIC_CLASSIFY_ROLLBACK_COMPAT_SEQ,
        createdAt: new Date("2026-09-01T02:00:00Z"),
      });

      const rows = await rawClient!.enforcementAction.findMany({
        where: { targetId: target.id, scopeKey: "GLOBAL" },
      });
      expect(rows).toHaveLength(3);
      const byId = new Map(rows.map((row) => [row.id, row]));

      const legacy = byId.get(`${RUN_TAG}-legacy-1`)!;
      expect(isPreMigrationLegacy(legacy)).toBe(true);
      expect(isCausallyOrdered(legacy)).toBe(false);
      expect(hasCompleteReversalProvenance(legacy)).toBe(false);
      expect(isAutoReversible(legacy)).toBe(false);

      const authoritative = byId.get(`${RUN_TAG}-auth-1`)!;
      expect(isPreMigrationLegacy(authoritative)).toBe(false);
      expect(isCausallyOrdered(authoritative)).toBe(true);
      expect(hasCompleteReversalProvenance(authoritative)).toBe(true);
      expect(isAutoReversible(authoritative)).toBe(true);

      // ROLLBACK_COMPAT：因果序 TRUE，但溯源不完整 → 安全降级不可自动反转
      const rollbackCompat = byId.get(`${RUN_TAG}-rollback-compat-1`)!;
      expect(isPreMigrationLegacy(rollbackCompat)).toBe(false);
      expect(isCausallyOrdered(rollbackCompat)).toBe(true);
      expect(hasCompleteReversalProvenance(rollbackCompat)).toBe(false);
      expect(isAutoReversible(rollbackCompat)).toBe(false);
    });

    // ------------------------------------------------------------------
    // 5. latestSameFamily：最高 seq 胜出；createdAt 不参与；跨 scope 隔离；
    //    ROLLBACK_COMPAT 可成为 latest
    // ------------------------------------------------------------------

    it("latestSameFamily：seq 最高者胜出（旧 createdAt）；ROLLBACK_COMPAT 可 supersede；跨 scope 隔离", async () => {
      const { latestSameFamilyAction } = await import("@/lib/enforcement/enforcement-sequence");
      const { withTransaction } = await import("@/lib/prisma");
      const campusB = await createFixtureCampus("campus-b-latest");
      const actor = await createFixtureUser("latest管理员", campusA.id);
      const target = await createFixtureUser("latest目标", campusA.id);

      const oldClock = new Date(Date.now() - 3_600_000);
      const nowClock = new Date();

      // r1：seq 更高但 createdAt 更旧；r2：seq 更低但 createdAt 更新
      await insertRawAction({
        id: `${RUN_TAG}-latest-r1`,
        type: "ACCOUNT_SUSPEND",
        actorId: actor.id,
        targetId: target.id,
        campusId: null,
        scopeKey: "GLOBAL",
        previousState: "USER:ACTIVE",
        resultState: "USER:SUSPENDED",
        enforcementSeq: SYNTHETIC_LATEST_R1_SEQ,
        createdAt: oldClock,
      });
      await insertRawAction({
        id: `${RUN_TAG}-latest-r2`,
        type: "ACCOUNT_REINSTATE",
        actorId: actor.id,
        targetId: target.id,
        campusId: null,
        scopeKey: "GLOBAL",
        previousState: "USER:SUSPENDED",
        resultState: "USER:ACTIVE",
        enforcementSeq: SYNTHETIC_LATEST_R2_SEQ,
        createdAt: nowClock,
      });

      // ACCOUNT family：r1（更高 seq）胜出——createdAt 不参与判定
      const latestViaSuspend = await withTransaction((tx) =>
        latestSameFamilyAction(tx, { targetId: target.id, scopeKey: "GLOBAL", type: "ACCOUNT_SUSPEND" }),
      );
      expect(latestViaSuspend?.id).toBe(`${RUN_TAG}-latest-r1`);

      const latestViaReinstate = await withTransaction((tx) =>
        latestSameFamilyAction(tx, { targetId: target.id, scopeKey: "GLOBAL", type: "ACCOUNT_REINSTATE" }),
      );
      expect(latestViaReinstate?.id).toBe(`${RUN_TAG}-latest-r1`);

      // ROLLBACK_COMPAT（previousState=null）：仍可成为 latest（禁止溯源过滤）
      await insertRawAction({
        id: `${RUN_TAG}-latest-r3`,
        type: "ACCOUNT_SUSPEND",
        actorId: actor.id,
        targetId: target.id,
        campusId: null,
        scopeKey: "GLOBAL",
        previousState: null,
        resultState: "USER:SUSPENDED",
        enforcementSeq: SYNTHETIC_LATEST_R3_SEQ,
        createdAt: oldClock,
      });
      const latestAfterCompat = await withTransaction((tx) =>
        latestSameFamilyAction(tx, { targetId: target.id, scopeKey: "GLOBAL", type: "ACCOUNT_REINSTATE" }),
      );
      expect(latestAfterCompat?.id).toBe(`${RUN_TAG}-latest-r3`);
      expect(latestAfterCompat?.previousState).toBeNull();

      // 跨 scope：CAMPUS:B 的高 seq 不 supersede CAMPUS:A
      await insertRawAction({
        id: `${RUN_TAG}-latest-cA`,
        type: "MEMBERSHIP_SUSPEND",
        actorId: actor.id,
        targetId: target.id,
        campusId: campusA.id,
        scopeKey: `CAMPUS:${campusA.id}`,
        previousState: "CAMPUS_MEMBERSHIP:ACTIVE",
        resultState: "CAMPUS_MEMBERSHIP:SUSPENDED",
        enforcementSeq: SYNTHETIC_LATEST_CA_SEQ,
        createdAt: oldClock,
      });
      await insertRawAction({
        id: `${RUN_TAG}-latest-cB`,
        type: "MEMBERSHIP_SUSPEND",
        actorId: actor.id,
        targetId: target.id,
        campusId: campusB.id,
        scopeKey: `CAMPUS:${campusB.id}`,
        previousState: "CAMPUS_MEMBERSHIP:ACTIVE",
        resultState: "CAMPUS_MEMBERSHIP:SUSPENDED",
        enforcementSeq: SYNTHETIC_LATEST_CB_SEQ,
        createdAt: nowClock,
      });

      const latestCampusA = await withTransaction((tx) =>
        latestSameFamilyAction(tx, {
          targetId: target.id,
          scopeKey: `CAMPUS:${campusA.id}`,
          type: "MEMBERSHIP_SUSPEND",
        }),
      );
      expect(latestCampusA?.id).toBe(`${RUN_TAG}-latest-cA`);
    });

    // ------------------------------------------------------------------
    // 6. previousState 六类矩阵（真实 service 产生 EA）
    // ------------------------------------------------------------------

    it("previousState 六类矩阵：ACCOUNT ×2 / MEMBERSHIP ×2 / RISK ×2（含 WATCH→RESTRICTED）", async () => {
      const { suspendAccount, reinstateAccount } = await import(
        "@/lib/enforcement/account-enforcement-service"
      );
      const { suspendCampusMembership, reinstateCampusMembership } = await import(
        "@/lib/enforcement/membership-enforcement-service"
      );
      const { setRiskState } = await import("@/lib/enforcement/risk-service");

      const accountTarget = await createFixtureUser("矩阵账号目标", campusA.id);
      const memberTarget = await createFixtureUser("矩阵成员目标", campusA.id);
      const riskGlobalTarget = await createFixtureUser("矩阵风控GLOBAL目标", campusA.id);
      const riskCampusTarget = await createFixtureUser("矩阵风控CAMPUS目标", campusA.id);
      const riskWatchTarget = await createFixtureUser("矩阵风控WATCH目标", campusA.id);

      // ACCOUNT_SUSPEND / ACCOUNT_REINSTATE
      await suspendAccount({
        actorId: globalAdmin.id,
        targetUserId: accountTarget.id,
        reasonCode: "ACCOUNT_SECURITY",
      });
      await reinstateAccount({
        actorId: globalAdmin.id,
        targetUserId: accountTarget.id,
        reasonCode: "FALSE_POSITIVE_CORRECTION",
      });

      // MEMBERSHIP_SUSPEND / MEMBERSHIP_REINSTATE
      await suspendCampusMembership({
        actorId: campusManager.id,
        targetUserId: memberTarget.id,
        campusId: campusA.id,
        reasonCode: "POLICY_VIOLATION",
      });
      await reinstateCampusMembership({
        actorId: campusManager.id,
        targetUserId: memberTarget.id,
        campusId: campusA.id,
        reasonCode: "FALSE_POSITIVE_CORRECTION",
      });

      // MARKETPLACE_RESTRICT（GLOBAL，无行 → canonical NORMAL）
      await setRiskState({
        actorId: globalAdmin.id,
        targetUserId: riskGlobalTarget.id,
        campusId: null,
        state: "RESTRICTED",
        reasonCode: "FRAUD_CONFIRMED",
      });

      // MARKETPLACE_RESTORE（RESTRICTED → NORMAL）
      await setRiskState({
        actorId: globalAdmin.id,
        targetUserId: riskGlobalTarget.id,
        campusId: null,
        state: "NORMAL",
        reasonCode: "FALSE_POSITIVE_CORRECTION",
      });

      // WATCH → RESTRICTED：previousState 必须是 WATCH（不能降级 NORMAL）
      await setRiskState({
        actorId: globalAdmin.id,
        targetUserId: riskWatchTarget.id,
        campusId: null,
        state: "WATCH",
        reasonCode: "MANUAL_REVIEW",
      });
      await setRiskState({
        actorId: globalAdmin.id,
        targetUserId: riskWatchTarget.id,
        campusId: null,
        state: "RESTRICTED",
        reasonCode: "FRAUD_CONFIRMED",
      });

      // CAMPUS 作用域 RESTRICT（无行 → NORMAL@campus）
      await setRiskState({
        actorId: globalAdmin.id,
        targetUserId: riskCampusTarget.id,
        campusId: campusA.id,
        state: "RESTRICTED",
        reasonCode: "POLICY_VIOLATION",
      });

      const expectations: Array<{
        targetId: string;
        type: string;
        previousState: string;
        resultState: string;
      }> = [
        {
          targetId: accountTarget.id,
          type: "ACCOUNT_SUSPEND",
          previousState: "USER:ACTIVE",
          resultState: "USER:SUSPENDED",
        },
        {
          targetId: accountTarget.id,
          type: "ACCOUNT_REINSTATE",
          previousState: "USER:SUSPENDED",
          resultState: "USER:ACTIVE",
        },
        {
          targetId: memberTarget.id,
          type: "MEMBERSHIP_SUSPEND",
          previousState: "CAMPUS_MEMBERSHIP:ACTIVE",
          resultState: "CAMPUS_MEMBERSHIP:SUSPENDED",
        },
        {
          targetId: memberTarget.id,
          type: "MEMBERSHIP_REINSTATE",
          previousState: "CAMPUS_MEMBERSHIP:SUSPENDED",
          resultState: "CAMPUS_MEMBERSHIP:ACTIVE",
        },
        {
          targetId: riskGlobalTarget.id,
          type: "MARKETPLACE_RESTRICT",
          previousState: "RISK_STATE:NORMAL@GLOBAL",
          resultState: "RISK_STATE:RESTRICTED@GLOBAL",
        },
        {
          targetId: riskGlobalTarget.id,
          type: "MARKETPLACE_RESTORE",
          previousState: "RISK_STATE:RESTRICTED@GLOBAL",
          resultState: "RISK_STATE:NORMAL@GLOBAL",
        },
        {
          targetId: riskWatchTarget.id,
          type: "MARKETPLACE_RESTRICT",
          previousState: "RISK_STATE:WATCH@GLOBAL",
          resultState: "RISK_STATE:RESTRICTED@GLOBAL",
        },
        {
          targetId: riskCampusTarget.id,
          type: "MARKETPLACE_RESTRICT",
          previousState: `RISK_STATE:NORMAL@CAMPUS:${campusA.id}`,
          resultState: `RISK_STATE:RESTRICTED@CAMPUS:${campusA.id}`,
        },
      ];

      for (const expected of expectations) {
        const rows = await rawClient!.enforcementAction.findMany({
          where: { targetId: expected.targetId, type: expected.type as never },
        });
        expect(rows, `${expected.type} for ${expected.targetId}`).toHaveLength(1);
        const row = rows[0]!;
        // 六类全部 previousState != null，且精确匹配 transition
        expect(row.previousState, `${expected.type} previousState`).toBe(expected.previousState);
        expect(row.resultState).toBe(expected.resultState);
        expect(row.enforcementSeq >= BOUNDARY).toBe(true);
      }
    }, 60_000);

    // ------------------------------------------------------------------
    // 7. upgrade migration：pre-6C schema + 既有行 → 新迁移
    // ------------------------------------------------------------------

    it("upgrade migration：旧行 previousState=null / seq legacy epoch；新写入 seq >= boundary", async () => {
      const base = integrationDatabaseUrl!;
      const dbName = `campus_p6c_upg_${randomUUID().slice(0, 8)}`;
      const tempUrl = swapDatabaseName(base, dbName);
      const maintenanceUrl = swapDatabaseName(base, "postgres");

      runPrismaDbExecute(`CREATE DATABASE "${dbName}";`, maintenanceUrl);

      let tempClient: PrismaClient | null = null;
      try {
        // ---- pre-6C schema（全部既有迁移，按目录名升序，排除新迁移）----
        const migrationsDir = path.resolve("prisma", "migrations");
        const preMigrations = readdirSync(migrationsDir)
          .filter((name) => /^\d{14}_/.test(name) && name !== NEW_MIGRATION)
          .sort();
        expect(preMigrations.length).toBeGreaterThan(0);

        const preSql = preMigrations
          .map((name) => readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8"))
          .join("\n\n");
        runPrismaDbExecute(preSql, tempUrl);

        // ---- 既有 EA 行（pre-6C 形状：无 previousState / enforcementSeq 列）----
        tempClient = new PrismaClient({ datasources: { db: { url: tempUrl } }, log: ["error"] });
        const campus = await tempClient.campus.create({
          data: { name: "升级测试校区", slug: `${RUN_TAG}-upg`, schoolName: "集成测试大学" },
        });
        createdCampusIds.push(campus.id);
        const actor = await tempClient.user.create({
          data: {
            email: `${RUN_TAG}-upg-actor@it.local`,
            name: "升级管理员",
            passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
            schoolName: "集成测试大学",
            campusId: campus.id,
          },
        });
        createdUserIds.push(actor.id);
        const target = await tempClient.user.create({
          data: {
            email: `${RUN_TAG}-upg-target@it.local`,
            name: "升级目标",
            passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
            schoolName: "集成测试大学",
            campusId: campus.id,
          },
        });
        createdUserIds.push(target.id);

        // 两行既有数据（backfill 相对顺序 NON_AUTHORITATIVE，绝不按 backfill
        // 顺序断言历史因果——只断言 epoch 范围 / 唯一 / 非空）
        const upgRun = randomUUID().slice(0, 8);
        await tempClient.$executeRawUnsafe(
          `INSERT INTO "EnforcementAction"
             ("id","type","actorId","targetId","campusId","scopeKey","reasonCode","note","sourceType","sourceId","resultState","createdAt")
           VALUES
             ('${RUN_TAG}-upg-old-1', 'ACCOUNT_SUSPEND', '${actor.id}', '${target.id}', NULL, 'GLOBAL', 'MANUAL_REVIEW', NULL, NULL, NULL, 'USER:SUSPENDED', '2026-09-01 00:00:00'),
             ('${RUN_TAG}-upg-old-2', 'ACCOUNT_REINSTATE', '${actor.id}', '${target.id}', NULL, 'GLOBAL', 'FALSE_POSITIVE_CORRECTION', NULL, NULL, NULL, 'USER:ACTIVE', '2026-09-02 00:00:00')`,
        );

        // ---- 应用新迁移 ----
        const newSql = readFileSync(
          path.resolve("prisma", "migrations", NEW_MIGRATION, "migration.sql"),
          "utf8",
        );
        runPrismaDbExecute(newSql, tempUrl);

        // ---- 旧行合同：previousState=NULL；seq > 0 且 < boundary；唯一；非空 ----
        const legacyRows = await tempClient.enforcementAction.findMany({
          where: { id: { in: [`${RUN_TAG}-upg-old-1`, `${RUN_TAG}-upg-old-2`] } },
          orderBy: { enforcementSeq: "asc" },
        });
        expect(legacyRows).toHaveLength(2);
        const legacySeqs = new Set<string>();
        for (const row of legacyRows) {
          expect(row.previousState).toBeNull();
          expect(row.enforcementSeq > BigInt(0)).toBe(true);
          expect(row.enforcementSeq < BOUNDARY).toBe(true);
          legacySeqs.add(row.enforcementSeq.toString());
        }
        expect(legacySeqs.size).toBe(2);

        // ---- 迁移后新写入：DB sequence 分配 → seq >= boundary ----
        const freshInsert = await tempClient.enforcementAction.create({
          data: {
            type: "ACCOUNT_SUSPEND",
            actorId: actor.id,
            targetId: target.id,
            campusId: null,
            scopeKey: "GLOBAL",
            reasonCode: "MANUAL_REVIEW",
            resultState: "USER:SUSPENDED",
            previousState: "USER:ACTIVE",
          },
        });
        expect(freshInsert.enforcementSeq >= BOUNDARY).toBe(true);
      } finally {
        await tempClient?.$disconnect();
        try {
          runPrismaDbExecute(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE);`, maintenanceUrl);
        } catch {
          // CI/本地偶发连接残留：FORCE 已尽力，不影响主流程断言
        }
      }
    }, 240_000);
  },
);
