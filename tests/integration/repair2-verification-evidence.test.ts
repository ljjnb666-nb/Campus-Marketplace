import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * RB-01 Repair 2：Legacy Verification Evidence Closure 集成测试（真实 PostgreSQL）。
 *
 * 证明（对真实授权路径，不 mock 读模型）：
 *  - HIST：pre-UploadedAsset 时代形态的 UserVerification.studentCardImage
 *    （/uploads/ 直链、http(s) 外链、未知串、恶意串、伪造 asset id、
 *    跨类别 PUBLIC 资产引用、'erased' 哨兵、空值）经
 *    loadAuthorizedVerificationDetail 的两阶段读后，DTO 仅对
 *    "受控 asset 引用 ∧ VERIFICATION ∧ PRIVATE ∧ 绑定本认证" 返回查看引用，
 *    其余一律 evidenceUnavailable 且原始值绝不进入 DTO/序列化输出；
 *  - MIGRATION：仓库真实 migration.sql（DATA_ONLY）幂等——重复执行两次
 *    结果一致（legacy 行清零、受控引用/'erased'/'' 原样保留、零重复行），
 *    §15 核验查询 LEGACY_READABLE_ROWS = 0；
 *  - SUBMIT（§23 新上传流回归）：submitMembershipVerification 只接受真实
 *    受控 asset 引用（绑定 ATTACHED + 引用重写），legacy token 拒绝且零写入；
 *  - ROUTE（TEST 5/9）：伪造 asset id → not_found；停用账号 viewer → forbidden。
 */

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const prisma = integrationDatabaseUrl ? (await import("@/lib/prisma")).prisma : null;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `rb01it-${randomUUID().slice(0, 8)}`;
// 校区按稳定 slug 复用且 teardown 不删除（与 rental-capacity-invariant 同款
// 纪律：避免对 phase7h CA02 全局 campus.count() 断言造成跨文件干扰）。
// TEST_FIXTURE_NAMING_DEBT：slug 前缀 rb02-* 是历史命名笔误（本文件属
// RB-01），保留以复用既有 Campus 行；改名会新建第二行 Campus，刻意不改。
const RB01_CAMPUS_SLUG = "rb02-verification-it";
const RB01_CAMPUS_SLUG_B = "rb02-verification-it-b";

/**
 * §15 迁移核验查询（与 migration.sql 内注释的核验查询一致）。
 * ids 限定本测试夹具行：全量套件并行运行时其它文件会并发制造 runtime
 * fixture 行（如 phase7f 的 "legacy" 行），全局计数在套件内天然竞态——
 * 全局版查询是"部署后静默库"的运营核验（deployment 后 LEGACY_READABLE_ROWS = 0）。
 */
async function legacyReadableRows(ids?: string[]) {
  const idFilter = ids?.length
    ? `AND "id" IN (${ids.map((_, i) => `$${i + 1}`).join(",")})`
    : "";
  const rows = await rawClient!.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*)::bigint AS n FROM "UserVerification"
     WHERE "studentCardImage" NOT LIKE 'asset:%'
       AND "studentCardImage" <> 'erased'
       AND "studentCardImage" <> ''${idFilter}`,
    ...(ids ?? []),
  );
  return Number(rows[0].n);
}

/** 读取仓库真实 migration.sql 并剥掉注释/事务包裹，返回可执行 UPDATE */
async function loadMigrationUpdate() {
  const migrationPath = path.resolve(
    process.cwd(),
    "prisma/migrations/20260923120000_repair2_verification_evidence_closure/migration.sql",
  );
  const raw = await readFile(migrationPath, "utf8");
  const statements = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .replace(/^BEGIN;$/gm, "")
    .replace(/^COMMIT;$/gm, "")
    .trim();
  if (!statements.toUpperCase().startsWith("UPDATE")) {
    throw new Error("unexpected migration body (RB-01 DATA_ONLY contract changed?)");
  }
  return statements;
}

describe.skipIf(!integrationDatabaseUrl)("verification evidence closure (RB-01, real PostgreSQL)", () => {
  let campusId = "";
  let campusBId = "";
  let reviewerId = "";
  let globalEvidenceReviewerId = "";
  let globalSensitiveReviewerId = "";
  let reviewerBId = "";
  let campusEvidenceRoleId = "";
  const adHocRoleIds: string[] = [];
  const userIds: string[] = [];
  const verificationIds: string[] = [];
  const assetIds: string[] = [];
  const assignmentIds: string[] = [];

  async function createFixtureUser(name: string, options: { status?: "ACTIVE" | "SUSPENDED" } = {}) {
    const user = await rawClient!.user.create({
      data: {
        email: `${RUN_TAG}-${userIds.length}-${name}@it.local`,
        name,
        passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
        schoolName: "集成测试大学",
        campusId,
        role: "STUDENT",
        status: options.status ?? "ACTIVE",
      },
    });
    userIds.push(user.id);
    return user;
  }

  async function createActiveMembership(userId: string) {
    const membership = await rawClient!.campusMembership.create({
      data: { userId, campusId, status: "ACTIVE" },
    });
    return membership;
  }

  async function createActiveMembershipForCampus(userId: string, membershipCampusId: string) {
    const membership = await rawClient!.campusMembership.create({
      data: { userId, campusId: membershipCampusId, status: "ACTIVE" },
    });
    return membership;
  }

  async function createVerificationRow(input: {
    studentCardImage: string;
    name?: string;
  }) {
    // UserVerification.userId @unique：每个证据行配独立学生
    const student = await createFixtureUser(input.name ?? "RB01 学生");
    const membership = await createActiveMembership(student.id);
    const submittedAt = new Date();
    const verification = await rawClient!.userVerification.create({
      data: {
        userId: student.id,
        membershipId: membership.id,
        schoolName: "集成测试大学",
        campusName: `${RUN_TAG}-校区`,
        studentIdLast4: "0000",
        studentCardImage: input.studentCardImage,
        status: "PENDING",
        submittedAt,
        reviewDueAt: new Date(submittedAt.getTime() + 48 * 60 * 60 * 1000),
      },
    });
    verificationIds.push(verification.id);
    return { verification, student, membership };
  }

  async function createEvidenceAsset(input: {
    ownerId: string;
    verificationId: string;
    access?: "PRIVATE" | "PUBLIC";
    category?: "VERIFICATION" | "REPORT";
  }) {
    const asset = await rawClient!.uploadedAsset.create({
      data: {
        ownerId: input.ownerId,
        category: input.category ?? "VERIFICATION",
        access: input.access ?? "PRIVATE",
        bucket: "campus-private",
        objectKey: `it/${RUN_TAG}/${assetIds.length}-${input.verificationId}.webp`,
        mimeType: "image/webp",
        sizeBytes: 1024,
        status: "ATTACHED",
        verificationId: input.verificationId,
        attachedAt: new Date(),
      },
    });
    assetIds.push(asset.id);
    return asset;
  }

  async function reviewDetail(verificationId: string) {
    const { loadAuthorizedVerificationDetail } = await import("@/lib/campus/verification-review-query");
    return loadAuthorizedVerificationDetail({
      access: { global: false, campusIds: [campusId] },
      verificationId,
    });
  }

  /** ad-hoc 角色（RUN_TAG 前缀，零共享状态）：绝不动 CAMPUS_VERIFICATION_REVIEWER */
  async function createAdHocRole(
    suffix: string,
    scope: "GLOBAL" | "CAMPUS",
    permissionKey: string,
  ) {
    const role = await rawClient!.role.create({
      data: {
        key: `${RUN_TAG}_${suffix}`,
        name: `${RUN_TAG}_${suffix}`,
        scope,
        isSystem: false,
        rolePermissions: {
          create: [{ permission: { connect: { key: permissionKey } } }],
        },
      },
    });
    adHocRoleIds.push(role.id);
    return role;
  }

  async function assignRole(userId: string, roleId: string, campusIdForScope: string | null) {
    const assignment = await rawClient!.userRoleAssignment.create({
      data: {
        userId,
        roleId,
        campusId: campusIdForScope,
        scopeKey: campusIdForScope ? `CAMPUS:${campusIdForScope}` : "GLOBAL",
      },
    });
    assignmentIds.push(assignment.id);
    return assignment;
  }

  beforeAll(async () => {
    const campus = await rawClient!.campus.upsert({
      where: { slug: RB01_CAMPUS_SLUG },
      create: { name: "RB02 认证证据集成校区", slug: RB01_CAMPUS_SLUG, schoolName: "集成测试大学" },
      update: {},
    });
    campusId = campus.id;
    // campusB：跨校区 DENY 用（同样稳定 slug 复用、teardown 不删）
    const campusB = await rawClient!.campus.upsert({
      where: { slug: RB01_CAMPUS_SLUG_B },
      create: { name: "RB02 认证证据集成校区B", slug: RB01_CAMPUS_SLUG_B, schoolName: "集成测试大学" },
      update: {},
    });
    campusBId = campusB.id;

    const reviewer = await createFixtureUser("RB01 审核员");
    reviewerId = reviewer.id;
    await createActiveMembership(reviewer.id);
    const campusEvidenceRole = await createAdHocRole("EVIDENCE_READER", "CAMPUS", "verification.evidence.read");
    campusEvidenceRoleId = campusEvidenceRole.id;
    await assignRole(reviewer.id, campusEvidenceRole.id, campusId);

    // AUTH-02/03/07：GLOBAL 权限审核角色
    const globalEvidenceReviewer = await createFixtureUser("RB01 全球证据审核员");
    globalEvidenceReviewerId = globalEvidenceReviewer.id;
    await createActiveMembership(globalEvidenceReviewer.id);
    const globalEvidenceRole = await createAdHocRole("GLOBAL_EVIDENCE", "GLOBAL", "verification.evidence.read");
    await assignRole(globalEvidenceReviewer.id, globalEvidenceRole.id, null);

    const globalSensitiveReviewer = await createFixtureUser("RB01 全球敏感读者");
    globalSensitiveReviewerId = globalSensitiveReviewer.id;
    await createActiveMembership(globalSensitiveReviewer.id);
    const globalSensitiveRole = await createAdHocRole("GLOBAL_SENSITIVE", "GLOBAL", "asset.sensitive.read");
    await assignRole(globalSensitiveReviewer.id, globalSensitiveRole.id, null);

    // AUTH-06：campusB 校区证据审核员（ACTIVE membership @B）
    const reviewerB = await createFixtureUser("RB01 校区B审核员");
    reviewerBId = reviewerB.id;
    await createActiveMembershipForCampus(reviewerB.id, campusBId);
    const campusBEvidenceRole = await createAdHocRole("EVIDENCE_READER_B", "CAMPUS", "verification.evidence.read");
    await assignRole(reviewerB.id, campusBEvidenceRole.id, campusBId);
  });

  afterAll(async () => {
    await rawClient!.userRoleAssignment.deleteMany({ where: { id: { in: assignmentIds } } });
    await rawClient!.rolePermission.deleteMany({ where: { roleId: { in: adHocRoleIds } } });
    await rawClient!.role.deleteMany({ where: { id: { in: adHocRoleIds } } });
    await rawClient!.uploadedAsset.deleteMany({ where: { id: { in: assetIds } } });
    await rawClient!.userVerification.deleteMany({ where: { id: { in: verificationIds } } });
    await rawClient!.notification.deleteMany({ where: { userId: { in: userIds } } });
    await rawClient!.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
    await rawClient!.user.deleteMany({ where: { id: { in: userIds } } });
    // 不删除 Campus 行（稳定 slug 复用，见 RB01_CAMPUS_SLUG 注释）
    await rawClient!.$disconnect();
    await prisma?.$disconnect();
  });

  it("HIST：历史形态证据经真实授权读模型 fail closed，仅受控引用可查看", async () => {
    // 受控链路：真实 PRIVATE VERIFICATION 资产 + 绑定 + 引用重写
    const controlled = await createVerificationRow({ studentCardImage: "placeholder", name: "RB01 受控学生" });
    const controlledAsset = await createEvidenceAsset({
      ownerId: controlled.student.id,
      verificationId: controlled.verification.id,
    });
    await rawClient!.userVerification.update({
      where: { id: controlled.verification.id },
      data: { studentCardImage: `asset:${controlledAsset.id}` },
    });

    // 跨类别绑定（TEST 6）：认证行引用 REPORT 类私有资产
    const wrongCategory = await createVerificationRow({ studentCardImage: "placeholder", name: "RB01 跨类学生" });
    const reportAsset = await createEvidenceAsset({
      ownerId: wrongCategory.student.id,
      verificationId: wrongCategory.verification.id,
      category: "REPORT",
    });
    await rawClient!.userVerification.update({
      where: { id: wrongCategory.verification.id },
      data: { studentCardImage: `asset:${reportAsset.id}` },
    });

    // PUBLIC × VERIFICATION 非法组合（TEST 7，DB 直写异常态）
    const publicAssetRow = await createVerificationRow({ studentCardImage: "placeholder", name: "RB01 公开学生" });
    const publicAsset = await createEvidenceAsset({
      ownerId: publicAssetRow.student.id,
      verificationId: publicAssetRow.verification.id,
      access: "PUBLIC",
    });
    await rawClient!.userVerification.update({
      where: { id: publicAssetRow.verification.id },
      data: { studentCardImage: `asset:${publicAsset.id}` },
    });

    // 其余历史/异常形态
    const legacyLocal = await createVerificationRow({
      studentCardImage: "/uploads/legacy-student-card.jpg",
      name: "RB01 本地直链学生",
    });
    const legacyExternal = await createVerificationRow({
      studentCardImage: "https://example.com/legacy-card.jpg",
      name: "RB01 外链学生",
    });
    const unknownRow = await createVerificationRow({ studentCardImage: "legacy", name: "RB01 未知串学生" });
    const maliciousRow = await createVerificationRow({
      studentCardImage: "javascript:alert(1)",
      name: "RB01 恶意串学生",
    });
    const fakeAssetRow = await createVerificationRow({
      studentCardImage: "asset:nonexistent0",
      name: "RB01 伪造引用学生",
    });
    const erasedRow = await createVerificationRow({ studentCardImage: "erased", name: "RB01 注销哨兵学生" });
    const emptyRow = await createVerificationRow({ studentCardImage: "", name: "RB01 空值学生" });

    // ---- 受控行：唯一可查看 ----
    const controlledDetail = await reviewDetail(controlled.verification.id);
    expect(controlledDetail.ok).toBe(true);
    if (controlledDetail.ok) {
      expect(controlledDetail.detail.studentCardImageRef).toBe(`asset:${controlledAsset.id}`);
      expect(controlledDetail.detail.evidenceUnavailable).toBe(false);
    }

    // ---- 全部 legacy/异常行：fail closed，原始值绝不进入 DTO ----
    const closedCases: Array<[string, string]> = [
      [wrongCategory.verification.id, `asset:${reportAsset.id}`],
      [publicAssetRow.verification.id, `asset:${publicAsset.id}`],
      [legacyLocal.verification.id, "/uploads/legacy-student-card.jpg"],
      [legacyExternal.verification.id, "https://example.com/legacy-card.jpg"],
      [unknownRow.verification.id, "legacy"],
      [maliciousRow.verification.id, "javascript:alert(1)"],
      [fakeAssetRow.verification.id, "asset:nonexistent0"],
      [erasedRow.verification.id, "erased"],
      [emptyRow.verification.id, ""],
    ];
    for (const [verificationId, rawValue] of closedCases) {
      const detail = await reviewDetail(verificationId);
      expect(detail.ok).toBe(true);
      if (detail.ok) {
        expect(detail.detail.studentCardImageRef).toBeNull();
        expect(detail.detail.evidenceUnavailable).toBe(true);
        const serialized = JSON.stringify(detail.detail);
        if (rawValue !== "") {
          expect(serialized).not.toContain(rawValue);
        }
      }
    }

    // 认证结论未被读模型/migration 语义改动（Repair 2 合同 §8）
    const statuses = await rawClient!.userVerification.findMany({
      where: { id: { in: verificationIds } },
      select: { status: true },
    });
    for (const row of statuses) {
      expect(row.status).toBe("PENDING");
    }
  });

  it("MIGRATION：真实 DATA_ONLY 迁移幂等，§15 核验查询清零", async () => {
    // 部署后环境里再造 legacy 行（模拟旧备份/坏 importer 重新引入）
    const beforeAsset = await rawClient!.uploadedAsset.create({
      data: {
        ownerId: (await createFixtureUser("RB01 迁移资产持有者")).id,
        category: "VERIFICATION",
        access: "PRIVATE",
        bucket: "campus-private",
        objectKey: `it/${RUN_TAG}/mig.webp`,
        mimeType: "image/webp",
        sizeBytes: 1024,
        status: "ATTACHED",
        attachedAt: new Date(),
      },
    });
    assetIds.push(beforeAsset.id);

    const migrateRow = await createVerificationRow({
      studentCardImage: "/uploads/migration-target.jpg",
      name: "RB01 迁移目标学生",
    });
    const keepAssetRow = await createVerificationRow({
      studentCardImage: `asset:${beforeAsset.id}`,
      name: "RB01 保留引用学生",
    });
    const keepErasedRow = await createVerificationRow({
      studentCardImage: "erased",
      name: "RB01 保留哨兵学生",
    });
    const keepEmptyRow = await createVerificationRow({ studentCardImage: "", name: "RB01 保留空值学生" });

    const migrationUpdate = await loadMigrationUpdate();
    const fixtureIds = [
      migrateRow.verification.id,
      keepAssetRow.verification.id,
      keepErasedRow.verification.id,
      keepEmptyRow.verification.id,
    ];

    // RUN 1 + RUN 2：幂等——同一终态、零重复资产行
    for (let run = 1; run <= 2; run += 1) {
      await rawClient!.$executeRawUnsafe(migrationUpdate);

      // §15：本测试夹具行内 LEGACY_READABLE_ROWS = 0
      expect(await legacyReadableRows(fixtureIds)).toBe(0);
      const after = await rawClient!.userVerification.findMany({
        where: { id: { in: fixtureIds } },
        select: { id: true, studentCardImage: true },
      });
      const byId = new Map(after.map((row) => [row.id, row.studentCardImage]));
      expect(byId.get(migrateRow.verification.id)).toBe("");
      expect(byId.get(keepAssetRow.verification.id)).toBe(`asset:${beforeAsset.id}`);
      expect(byId.get(keepErasedRow.verification.id)).toBe("erased");
      expect(byId.get(keepEmptyRow.verification.id)).toBe("");
      expect(await rawClient!.uploadedAsset.count({ where: { id: beforeAsset.id } })).toBe(1);
    }

    // 迁移不改认证结论（§8）
    const migratedStatus = await rawClient!.userVerification.findUniqueOrThrow({
      where: { id: migrateRow.verification.id },
      select: { status: true },
    });
    expect(migratedStatus.status).toBe("PENDING");
  });

  it("SUBMIT：新上传流（真实资产引用）通过并绑定；legacy token 拒绝且零写入（§23）", async () => {
    const { submitMembershipVerification } = await import("@/lib/campus/verification-service");

    const studentB = await createFixtureUser("RB01 学生B");
    const membershipB = await createActiveMembership(studentB.id);

    // 学生上传产生 UPLOADED 资产 → 引用提交（现代链路）
    const uploaded = await rawClient!.uploadedAsset.create({
      data: {
        ownerId: studentB.id,
        category: "VERIFICATION",
        access: "PRIVATE",
        bucket: "campus-private",
        objectKey: `it/${RUN_TAG}/submit.webp`,
        mimeType: "image/webp",
        sizeBytes: 1024,
        status: "UPLOADED",
      },
    });
    assetIds.push(uploaded.id);

    const verification = await submitMembershipVerification({
      userId: studentB.id,
      schoolName: "集成测试大学",
      campusName: `${RUN_TAG}-校区`,
      studentIdLast4: "1234",
      studentCardImageToken: `asset:${uploaded.id}`,
    });
    verificationIds.push(verification.id);

    expect(verification.studentCardImage).toBe(`asset:${uploaded.id}`);
    const attached = await rawClient!.uploadedAsset.findUniqueOrThrow({
      where: { id: uploaded.id },
      select: { status: true, verificationId: true },
    });
    expect(attached.status).toBe("ATTACHED");
    expect(attached.verificationId).toBe(verification.id);

    // legacy token：service 层 fail closed，零写入
    // （计数 scoped 到本夹具用户——全局 count 在并行套件内跨文件竞态）
    const before = await rawClient!.userVerification.count({
      where: { userId: studentB.id },
    });
    await expect(
      submitMembershipVerification({
        userId: studentB.id,
        schoolName: "集成测试大学",
        campusName: `${RUN_TAG}-校区`,
        studentIdLast4: "1234",
        studentCardImageToken: "https://example.com/card.jpg",
      }),
    ).rejects.toMatchObject({ code: "VERIFICATION_EVIDENCE_INVALID" });
    expect(
      await rawClient!.userVerification.count({ where: { userId: studentB.id } }),
    ).toBe(before);
  });

  it("ROUTE：伪造 asset id → not_found；停用 viewer → forbidden（TEST 5/9）", async () => {
    const { resolvePrivateAssetAccess } = await import("@/lib/asset-service");

    // TEST 5：asset:<不存在的 id>（经渲染解析已 UNAVAILABLE；直连路由亦 not_found）
    const fake = await resolvePrivateAssetAccess("nonexistent0", { id: reviewerId });
    expect(fake).toMatchObject({ ok: false, reason: "not_found" });

    // 停用 viewer：即使持 evidence 权限角色也 fail closed
    const suspendedReviewer = await createFixtureUser("RB01 停用审核员", { status: "SUSPENDED" });
    const suspendedAssignment = await rawClient!.userRoleAssignment.create({
      data: {
        userId: suspendedReviewer.id,
        roleId: campusEvidenceRoleId,
        campusId,
        scopeKey: `CAMPUS:${campusId}`,
      },
    });
    assignmentIds.push(suspendedAssignment.id);
    await createActiveMembership(suspendedReviewer.id);

    const evidenceRow = await createVerificationRow({
      studentCardImage: "placeholder",
      name: "RB01 路由证据学生",
    });
    const asset = await createEvidenceAsset({
      ownerId: evidenceRow.student.id,
      verificationId: evidenceRow.verification.id,
    });

    const denied = await resolvePrivateAssetAccess(asset.id, { id: suspendedReviewer.id });
    expect(denied).toMatchObject({ ok: false, reason: "forbidden" });

    // 对照：active reviewer 经 permission 路径放行（grantedBy=permission，
    // 与 content 路由 VERIFICATION_ASSET_ACCESSED 审计触发合同一致）
    const allowed = await resolvePrivateAssetAccess(asset.id, { id: reviewerId });
    expect(allowed).toMatchObject({ ok: true, grantedBy: "permission" });
  });

  it("AUTH-01..07：REVIEW_FIX 绑定门——owner 合同保留，非 owner 必须受控绑定 + campus 精确匹配", async () => {
    const { resolvePrivateAssetAccess } = await import("@/lib/asset-service");

    // AUTH-01：owner + VERIFICATION + PRIVATE + UPLOADED + unbound → ALLOW
    // （上传完成、正式提交前的本人预览能力 = 既有 owner lifecycle 合同，不破坏）
    const uploadOwner = await createFixtureUser("RB01 AUTH 上传者");
    await createActiveMembership(uploadOwner.id);
    const unboundAsset = await rawClient!.uploadedAsset.create({
      data: {
        ownerId: uploadOwner.id,
        category: "VERIFICATION",
        access: "PRIVATE",
        bucket: "campus-private",
        objectKey: `it/${RUN_TAG}/auth-unbound.webp`,
        mimeType: "image/webp",
        sizeBytes: 1024,
        status: "UPLOADED",
      },
    });
    assetIds.push(unboundAsset.id);

    const ownerView = await resolvePrivateAssetAccess(unboundAsset.id, { id: uploadOwner.id });
    expect(ownerView).toMatchObject({ ok: true, grantedBy: "owner" });

    // AUTH-02：GLOBAL verification.evidence.read + unbound UPLOADED → DENY
    // （本次 review blocker 的最重要 regression）
    const deniedGlobalEvidence = await resolvePrivateAssetAccess(unboundAsset.id, {
      id: globalEvidenceReviewerId,
    });
    expect(deniedGlobalEvidence).toMatchObject({ ok: false, reason: "forbidden" });

    // AUTH-03：GLOBAL asset.sensitive.read + unbound UPLOADED → DENY
    const deniedGlobalSensitive = await resolvePrivateAssetAccess(unboundAsset.id, {
      id: globalSensitiveReviewerId,
    });
    expect(deniedGlobalSensitive).toMatchObject({ ok: false, reason: "forbidden" });

    // AUTH-04：CAMPUS reviewer + unbound → DENY（不得经 owner campus 推导）
    const deniedCampusReviewer = await resolvePrivateAssetAccess(unboundAsset.id, {
      id: reviewerId,
    });
    expect(deniedCampusReviewer).toMatchObject({ ok: false, reason: "forbidden" });

    // ---- bound 正向路径 ----
    const boundVerification = await createVerificationRow({
      studentCardImage: "placeholder",
      name: "RB01 AUTH 绑定行学生",
    });
    const boundAsset = await rawClient!.uploadedAsset.create({
      data: {
        ownerId: boundVerification.student.id,
        category: "VERIFICATION",
        access: "PRIVATE",
        bucket: "campus-private",
        objectKey: `it/${RUN_TAG}/auth-bound.webp`,
        mimeType: "image/webp",
        sizeBytes: 1024,
        status: "ATTACHED",
        verificationId: boundVerification.verification.id,
        attachedAt: new Date(),
      },
    });
    assetIds.push(boundAsset.id);

    // AUTH-05：matching campus reviewer + bound → ALLOW（grantedBy=permission）
    const campusAllowed = await resolvePrivateAssetAccess(boundAsset.id, { id: reviewerId });
    expect(campusAllowed).toMatchObject({ ok: true, grantedBy: "permission" });

    // AUTH-06：wrong-campus reviewer + bound → DENY
    const wrongCampus = await resolvePrivateAssetAccess(boundAsset.id, { id: reviewerBId });
    expect(wrongCampus).toMatchObject({ ok: false, reason: "forbidden" });

    // AUTH-07：GLOBAL reviewer + bound → ALLOW（GLOBAL 仍有效，只是不再覆盖 unbound）
    const globalAllowed = await resolvePrivateAssetAccess(boundAsset.id, {
      id: globalEvidenceReviewerId,
    });
    expect(globalAllowed).toMatchObject({ ok: true, grantedBy: "permission" });
    const globalSensitiveAllowed = await resolvePrivateAssetAccess(boundAsset.id, {
      id: globalSensitiveReviewerId,
    });
    expect(globalSensitiveAllowed).toMatchObject({ ok: true, grantedBy: "permission" });

    // owner（bound 资产本人）仍 ALLOW
    const boundOwner = await resolvePrivateAssetAccess(boundAsset.id, {
      id: boundVerification.student.id,
    });
    expect(boundOwner).toMatchObject({ ok: true, grantedBy: "owner" });
  });

  it("READ_MODEL_BINDING_MISMATCH：A 行引用绑定到 B 行的资产 → UNAVAILABLE（§13 回归）", async () => {
    const { resolveVerificationEvidenceDisplay } = await import(
      "@/lib/campus/verification-review-query"
    );

    // 资产真实绑定在 verificationB 上
    const verificationB = await createVerificationRow({ studentCardImage: "placeholder", name: "RB01 错绑B学生" });
    const assetB = await createEvidenceAsset({
      ownerId: verificationB.student.id,
      verificationId: verificationB.verification.id,
    });

    // verificationA 的 studentCardImage 指向 assetB（跨行错绑）
    const verificationA = await createVerificationRow({
      studentCardImage: `asset:${assetB.id}`,
      name: "RB01 错绑A学生",
    });

    const display = await resolveVerificationEvidenceDisplay(
      verificationA.verification.id,
      `asset:${assetB.id}`,
    );

    expect(display).toEqual({ state: "UNAVAILABLE" });
  });
});
