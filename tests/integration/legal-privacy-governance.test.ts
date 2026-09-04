import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phase 5 治理域集成测试 + Privacy/Governance Drill（真实 PostgreSQL）。
 *
 * 必须保持在单一文件内顺序执行：治理域的 required 政策集合是全局状态，
 * 拆分多文件会因 vitest 文件级并行产生跨文件发布/同意竞态。
 *
 * 服务层经 @/lib/prisma 单例访问 DATABASE_URL（CI job 级已设置并指向
 * INTEGRATION_DATABASE_URL 同库）；清理走独立裸客户端硬删除。
 *
 * Drill 覆盖清单：
 *  1. user missing acceptance → blocked
 *  2. acceptance restores access
 *  3. stale policy → reconsent
 *  4. export contains no forbidden fields
 *  5. active hold → erasure blocked
 *  6. released hold → deletion path allowed
 *  7. erased account → auth denied
 *  8. historical transaction still valid
 */
const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const prisma = integrationDatabaseUrl ? (await import("@/lib/prisma")).prisma : null;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `gov-it-${randomUUID().slice(0, 8)}`;

const createdUserIds: string[] = [];
const createdDocumentIds: string[] = [];
const createdOrderNos: string[] = [];
const holdIds: string[] = [];

async function nextVersion(
  type: "TERMS_OF_SERVICE" | "PRIVACY_POLICY" | "PLATFORM_RULES" | "PROHIBITED_TRANSACTIONS",
): Promise<number> {
  const highest = await rawClient!.legalDocument.findFirst({
    where: { type },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  return (highest?.version ?? 900) + 1;
}

async function createFixtureUser(name: string) {
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${createdUserIds.length}@it.local`,
      name,
      passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfixtureitfix",
      schoolName: "集成测试大学",
      campus: {
        connectOrCreate: {
          where: { slug: "it-main-campus" },
          create: { name: "集成主校区", slug: "it-main-campus", schoolName: "集成测试大学" },
        },
      },
    },
  });
  createdUserIds.push(user.id);

  return user;
}

describe.skipIf(!integrationDatabaseUrl)("Phase 5 治理集成测试 + Privacy Drill（真实 PostgreSQL）", () => {
  let exportOwnerId = "";
  let otherUserId = "";

  beforeAll(async () => {
    await rawClient!.campus.upsert({
      where: { slug: "it-main-campus" },
      update: {},
      create: { name: "集成主校区", slug: "it-main-campus", schoolName: "集成测试大学" },
    });

    const owner = await createFixtureUser("导出主体");
    const other = await createFixtureUser("其他用户");
    exportOwnerId = owner.id;
    otherUserId = other.id;

    // 他人私密字段 fixture：导出绝不允许携带
    await rawClient!.user.update({
      where: { id: otherUserId },
      data: { phone: "13800138000", studentIdLast4: "9988" },
    });
  });

  afterAll(async () => {
    await rawClient!.dataHold.deleteMany({ where: { id: { in: holdIds } } });
    await rawClient!.order.deleteMany({ where: { orderNo: { in: createdOrderNos } } });
    await rawClient!.uploadedAsset.deleteMany({ where: { ownerId: { in: createdUserIds } } });
    await rawClient!.policyAcceptance.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.privacyRequest.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.userVerification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await rawClient!.legalDocument.deleteMany({ where: { id: { in: createdDocumentIds } } });
    await rawClient!.$disconnect();
    await prisma?.$disconnect();
  });

  // ============================================================
  // 法务文档域
  // ============================================================

  it("发布文档后持久化精确 SHA-256 content hash，且 (type,version) 唯一", async () => {
    const { createLegalDocument, publishLegalDocument, computeContentHash } = await import(
      "@/lib/legal/legal-document-service"
    );

    const content = `# 集成测试协议 ${RUN_TAG}\n\n第一条 本协议仅用于集成测试。`;
    const version = await nextVersion("TERMS_OF_SERVICE");
    const draft = await createLegalDocument({
      type: "TERMS_OF_SERVICE",
      version,
      title: `集成测试协议 ${RUN_TAG}`,
      content,
    });
    createdDocumentIds.push(draft.id);

    expect(draft.status).toBe("DRAFT");
    expect(draft.contentHash).toBe(computeContentHash(content));

    const published = await publishLegalDocument(draft.id);

    expect(published.status).toBe("PUBLISHED");
    expect(published.publishedAt).toBeTruthy();
    expect(published.contentHash).toBe(computeContentHash(content));

    // 重复 (type, version) 被数据库唯一约束拒绝
    await expect(
      createLegalDocument({
        type: "TERMS_OF_SERVICE",
        version,
        title: "重复版本",
        content: "重复",
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("acceptance 引用确切文档并固化版本/hash 快照（fail-closed 全集合提交）", async () => {
    const { createLegalDocument, publishLegalDocument, computeContentHash } = await import(
      "@/lib/legal/legal-document-service"
    );
    const { getRequiredPolicies, recordAcceptances } = await import("@/lib/legal/policy-service");

    const content = `# 隐私政策 ${RUN_TAG}`;
    const document = await publishLegalDocument(
      (
        await createLegalDocument({
          type: "PRIVACY_POLICY",
          version: await nextVersion("PRIVACY_POLICY"),
          title: `集成隐私政策 ${RUN_TAG}`,
          content,
        })
      ).id,
    );
    createdDocumentIds.push(document.id);

    const user = await createFixtureUser("快照用户");

    const required = await getRequiredPolicies();
    expect(required.some((entry) => entry.id === document.id)).toBe(true);
    await recordAcceptances({
      userId: user.id,
      documentIds: required.map((entry) => entry.id),
      source: "SIGNUP",
    });

    const evidence = await rawClient!.policyAcceptance.findUnique({
      where: { userId_documentId: { userId: user.id, documentId: document.id } },
    });

    expect(evidence).toBeTruthy();
    expect(evidence!.documentType).toBe("PRIVACY_POLICY");
    expect(evidence!.documentVersion).toBe(document.version);
    expect(evidence!.documentHash).toBe(computeContentHash(content));
  });

  it("版本升级后旧用户变为 OUTDATED，stale 提交 fail closed，重新同意后恢复", async () => {
    const { createLegalDocument, publishLegalDocument } = await import(
      "@/lib/legal/legal-document-service"
    );
    const { getRequiredPolicies, getUserAcceptanceStatus, recordAcceptances } = await import(
      "@/lib/legal/policy-service"
    );
    const { GovernanceError } = await import("@/lib/governance/domain-errors");

    const user = await createFixtureUser("升级用户");

    const rulesBase = await nextVersion("PLATFORM_RULES");
    const v1 = await publishLegalDocument(
      (
        await createLegalDocument({
          type: "PLATFORM_RULES",
          version: rulesBase,
          title: `规则 v1 ${RUN_TAG}`,
          content: `规则 v1 ${RUN_TAG}`,
        })
      ).id,
    );
    createdDocumentIds.push(v1.id);

    await recordAcceptances({
      userId: user.id,
      documentIds: (await getRequiredPolicies()).map((entry) => entry.id),
      source: "SIGNUP",
    });
    expect(
      (await getUserAcceptanceStatus(user.id)).pending.find((entry) => entry.id === v1.id),
    ).toBeUndefined();

    // 发布 v2：rules 类型出现新 current
    const v2 = await publishLegalDocument(
      (
        await createLegalDocument({
          type: "PLATFORM_RULES",
          version: rulesBase + 1,
          title: `规则 v2 ${RUN_TAG}`,
          content: `规则 v2 ${RUN_TAG}`,
        })
      ).id,
    );
    createdDocumentIds.push(v2.id);

    const current = await getRequiredPolicies();
    expect(current.find((entry) => entry.id === v2.id)).toBeTruthy();
    expect(current.find((entry) => entry.id === v1.id)).toBeUndefined();

    const outdated = await getUserAcceptanceStatus(user.id);
    expect(outdated.compliant).toBe(false);
    expect(outdated.pending.find((entry) => entry.id === v2.id)?.state).toBe("OUTDATED");

    // stale 提交（旧版本文档 id）→ NOT_CURRENT
    await expect(
      recordAcceptances({ userId: user.id, documentIds: [v1.id], source: "RECONSENT" }),
    ).rejects.toBeInstanceOf(GovernanceError);

    // 完整当前集合 → 恢复
    await recordAcceptances({
      userId: user.id,
      documentIds: (await getRequiredPolicies()).map((entry) => entry.id),
      source: "RECONSENT",
    });
    expect((await getUserAcceptanceStatus(user.id)).compliant).toBe(true);
  });

  it("并发重复接受同一文档只产生一条证据（幂等 + 唯一约束）", async () => {
    const { createLegalDocument, publishLegalDocument } = await import(
      "@/lib/legal/legal-document-service"
    );
    const { getRequiredPolicies, recordAcceptances } = await import("@/lib/legal/policy-service");

    const document = await publishLegalDocument(
      (
        await createLegalDocument({
          type: "PROHIBITED_TRANSACTIONS",
          version: await nextVersion("PROHIBITED_TRANSACTIONS"),
          title: `红线 ${RUN_TAG}`,
          content: `红线 ${RUN_TAG}`,
        })
      ).id,
    );
    createdDocumentIds.push(document.id);

    const user = await createFixtureUser("并发用户");
    const submitFullSet = async () =>
      recordAcceptances({
        userId: user.id,
        documentIds: (await getRequiredPolicies()).map((entry) => entry.id),
        source: "SIGNUP",
      });

    // 双击并发：唯一约束兜底，不产生重复证据
    await Promise.allSettled([submitFullSet(), submitFullSet()]);

    const rows = await rawClient!.policyAcceptance.findMany({
      where: { userId: user.id, documentId: document.id },
    });

    expect(rows).toHaveLength(1);
  });

  // ============================================================
  // 隐私域：导出 / hold / 注销
  // ============================================================

  it("导出包含本人数据但不泄漏他人私密字段与任何内部秘密", async () => {
    const { buildUserExport, assertNoForbiddenExportFields } = await import(
      "@/lib/privacy/data-export"
    );

    const orderNo = `${RUN_TAG}-O1`;
    createdOrderNos.push(orderNo);
    await rawClient!.order.create({
      data: {
        orderNo,
        type: "PRODUCT",
        status: "COMPLETED",
        amount: "66.00",
        buyerId: exportOwnerId,
        sellerId: otherUserId,
      },
    });

    const payload = await buildUserExport(exportOwnerId);
    const serialized = JSON.stringify(payload);

    expect(payload.orders.some((order) => order.orderNo === orderNo)).toBe(true);

    const otherUser = await rawClient!.user.findUniqueOrThrow({ where: { id: otherUserId } });
    expect(serialized.includes(otherUser.email)).toBe(false);
    expect(serialized.includes("13800138000")).toBe(false);
    expect(serialized.includes("9988")).toBe(false);

    for (const forbidden of [
      "passwordHash",
      "sessionToken",
      "objectKey",
      "bucket",
      "databaseUrl",
      "redisUrl",
      "studentCardImage",
    ]) {
      expect(serialized.includes(forbidden)).toBe(false);
    }

    expect(() => assertNoForbiddenExportFields(payload)).not.toThrow();
  });

  it("hold 阻断注销（BLOCKED + 零部分擦除 + 重复请求 ALREADY_ACTIVE）", async () => {
    const { createHold } = await import("@/lib/privacy/data-hold-service");
    const { createAccountDeletionRequest } = await import(
      "@/lib/privacy/privacy-request-service"
    );
    const { GovernanceError } = await import("@/lib/governance/domain-errors");

    const hold = await createHold({
      type: "LEGAL",
      subjectId: exportOwnerId,
      reasonCode: "IT_LEGAL_HOLD",
    });
    holdIds.push(hold.id);

    const outcome = await createAccountDeletionRequest(exportOwnerId);

    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.request.reasonCode).toBe("ACTIVE_DATA_HOLD");

    const user = await rawClient!.user.findUnique({ where: { id: exportOwnerId } });
    expect(user!.erasedAt).toBeNull();
    expect(user!.email).toContain("@it.local");
    expect(user!.name).toBe("导出主体");

    await expect(createAccountDeletionRequest(exportOwnerId)).rejects.toBeInstanceOf(GovernanceError);
  });

  it("进行中交易阻断注销（ACTIVE_TRANSACTION_BLOCK）", async () => {
    const { releaseHold } = await import("@/lib/privacy/data-hold-service");
    const { retryBlockedRequest } = await import("@/lib/privacy/privacy-request-service");

    await releaseHold(holdIds[0]);

    const pendingOrderNo = `${RUN_TAG}-O2`;
    createdOrderNos.push(pendingOrderNo);
    await rawClient!.order.create({
      data: {
        orderNo: pendingOrderNo,
        type: "PRODUCT",
        status: "PENDING",
        amount: "10.00",
        buyerId: exportOwnerId,
        sellerId: otherUserId,
      },
    });

    // 治理 seam：BLOCKED → IN_PROGRESS → 撞上 active order → BLOCKED
    const blockedRequest = await rawClient!.privacyRequest.findFirstOrThrow({
      where: { userId: exportOwnerId, type: "ACCOUNT_DELETION", status: "BLOCKED" },
      orderBy: { requestedAt: "desc" },
    });

    const outcome = await retryBlockedRequest(blockedRequest.id);

    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.request.reasonCode).toBe("ACTIVE_TRANSACTION_BLOCK");
  });

  it("hold 解除 + 交易完成后：匿名化完成、历史订单保持、凭据失效、注销后导出被拒", async () => {
    const { retryBlockedRequest } = await import("@/lib/privacy/privacy-request-service");

    await rawClient!.order.updateMany({
      where: { orderNo: `${RUN_TAG}-O2` },
      data: { status: "COMPLETED" },
    });

    const blockedRequest = await rawClient!.privacyRequest.findFirstOrThrow({
      where: { userId: exportOwnerId, type: "ACCOUNT_DELETION", status: "BLOCKED" },
      orderBy: { requestedAt: "desc" },
    });

    const outcome = await retryBlockedRequest(blockedRequest.id);

    expect(outcome.status).toBe("COMPLETED");

    const erased = await rawClient!.user.findUnique({ where: { id: exportOwnerId } });

    expect(erased!.erasedAt).toBeTruthy();
    expect(erased!.name).toBe("已注销用户");
    expect(erased!.email).toMatch(/^erased-[0-9a-f-]+@erased\.invalid$/);
    expect(erased!.phone).toBeNull();
    expect(erased!.studentIdLast4).toBeNull();

    // 凭据失效：原口令不再匹配随机替换哈希
    const { compare } = await import("bcryptjs");
    expect(await compare("any-password", erased!.passwordHash)).toBe(false);

    // 历史订单 referential integrity 保持
    const order = await rawClient!.order.findUnique({ where: { orderNo: `${RUN_TAG}-O1` } });
    expect(order).toBeTruthy();
    expect(order!.buyerId).toBe(exportOwnerId);

    // 与 authorize 相同判定：注销后不可登录
    const loginable =
      erased!.deletedAt === null && erased!.erasedAt === null && erased!.status === "ACTIVE";
    expect(loginable).toBe(false);

    // 注销后导出被拒
    const { buildUserExport } = await import("@/lib/privacy/data-export");
    const { GovernanceError } = await import("@/lib/governance/domain-errors");
    await expect(buildUserExport(exportOwnerId)).rejects.toBeInstanceOf(GovernanceError);

    const request = await rawClient!.privacyRequest.findFirst({
      where: { userId: exportOwnerId, type: "ACCOUNT_DELETION" },
      orderBy: { requestedAt: "desc" },
    });
    expect(request!.status).toBe("COMPLETED");
  });

  it("TOCTOU 防护：破坏性事务内可见并发创建的 hold（READ COMMITTED 语义）", async () => {
    const { assertNoActiveHold } = await import("@/lib/privacy/data-hold-service");
    const { withTransaction } = await import("@/lib/prisma");

    const target = await createFixtureUser("竞态目标");

    await expect(
      withTransaction(async (tx) => {
        const hold = await rawClient!.dataHold.create({
          data: { type: "DISPUTE", subjectId: target.id, reasonCode: "IT_RACE_HOLD" },
        });
        holdIds.push(hold.id);

        return assertNoActiveHold(target.id, tx as never);
      }),
    ).rejects.toMatchObject({ code: "ACTIVE_DATA_HOLD" });
  });

  // ============================================================
  // Privacy / Governance Drill（可重复演练清单）
  // ============================================================

  it("drill 1-2：missing acceptance 阻断 → 完整同意后恢复访问", async () => {
    const { assertRequiredPoliciesAccepted, getRequiredPolicies, recordAcceptances } = await import(
      "@/lib/legal/policy-service"
    );
    const { createLegalDocument, publishLegalDocument } = await import(
      "@/lib/legal/legal-document-service"
    );

    // 环境兜底：无已发布政策时补发演练文档（走真实 publish 服务）
    if ((await getRequiredPolicies()).length === 0) {
      const draft = await createLegalDocument({
        type: "TERMS_OF_SERVICE",
        version: await nextVersion("TERMS_OF_SERVICE"),
        title: `演练协议 ${RUN_TAG}`,
        content: `演练协议 ${RUN_TAG}`,
      });
      await publishLegalDocument(draft.id);
      createdDocumentIds.push(draft.id);
    }

    const userA = await createFixtureUser("演练用户A");

    // 1. 未同意 → gate 阻断
    await expect(assertRequiredPoliciesAccepted(userA.id)).rejects.toMatchObject({
      code: "LEGAL_ACCEPTANCE_REQUIRED",
    });

    // 2. 明确同意当前集合 → 恢复
    await recordAcceptances({
      userId: userA.id,
      documentIds: (await getRequiredPolicies()).map((entry) => entry.id),
      source: "RECONSENT",
    });
    await expect(assertRequiredPoliciesAccepted(userA.id)).resolves.toBeUndefined();
  });

  it("drill 3：版本升级 → stale 同意要求 reconsent", async () => {
    const { createLegalDocument, publishLegalDocument } = await import(
      "@/lib/legal/legal-document-service"
    );
    const { getRequiredPolicies, getUserAcceptanceStatus, recordAcceptances } = await import(
      "@/lib/legal/policy-service"
    );

    const userB = await createFixtureUser("演练用户B");

    // 先建立基线同意
    await recordAcceptances({
      userId: userB.id,
      documentIds: (await getRequiredPolicies()).map((entry) => entry.id),
      source: "SIGNUP",
    });
    expect((await getUserAcceptanceStatus(userB.id)).compliant).toBe(true);

    // 发布 TERMS 新版本 → 基线同意过期
    const upgraded = await publishLegalDocument(
      (
        await createLegalDocument({
          type: "TERMS_OF_SERVICE",
          version: await nextVersion("TERMS_OF_SERVICE"),
          title: `演练协议 v-next ${RUN_TAG}`,
          content: `演练协议 v-next ${RUN_TAG}`,
        })
      ).id,
    );
    createdDocumentIds.push(upgraded.id);

    const status = await getUserAcceptanceStatus(userB.id);
    expect(status.compliant).toBe(false);
    expect(status.pending.find((entry) => entry.id === upgraded.id)?.state).toBe("OUTDATED");

    await recordAcceptances({
      userId: userB.id,
      documentIds: (await getRequiredPolicies()).map((entry) => entry.id),
      source: "RECONSENT",
    });
    expect((await getUserAcceptanceStatus(userB.id)).compliant).toBe(true);
  });

  it("drill 5-8：hold 阻断 → 解除后注销完成 → 认证拒绝，历史交易保持有效", async () => {
    const { createHold } = await import("@/lib/privacy/data-hold-service");
    const { createAccountDeletionRequest, retryBlockedRequest } = await import(
      "@/lib/privacy/privacy-request-service"
    );

    const userC = await createFixtureUser("演练用户C");
    const userD = await createFixtureUser("演练用户D");

    // 历史交易 fixture
    const orderNo = `${RUN_TAG}-D1`;
    createdOrderNos.push(orderNo);
    const order = await rawClient!.order.create({
      data: {
        orderNo,
        type: "PRODUCT",
        status: "COMPLETED",
        amount: "88.00",
        buyerId: userC.id,
        sellerId: userD.id,
      },
    });

    // 5. active hold → blocked
    const hold = await createHold({
      type: "DISPUTE",
      subjectId: userC.id,
      reasonCode: "DRILL_DISPUTE_HOLD",
    });
    const blocked = await createAccountDeletionRequest(userC.id);
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.request.reasonCode).toBe("ACTIVE_DATA_HOLD");

    // 6. released hold → deletion path allowed（治理 seam 重试）
    await rawClient!.dataHold.update({
      where: { id: hold.id },
      data: { status: "RELEASED", releasedAt: new Date() },
    });

    const outcome = await retryBlockedRequest(blocked.request.id);
    expect(outcome.status).toBe("COMPLETED");

    // 7. erased account → auth denied
    const erased = await rawClient!.user.findUnique({ where: { id: userC.id } });
    expect(erased!.erasedAt).toBeTruthy();
    const loginable =
      erased!.deletedAt === null && erased!.erasedAt === null && erased!.status === "ACTIVE";
    expect(loginable).toBe(false);

    // 8. historical transaction still valid
    const history = await rawClient!.order.findUnique({ where: { id: order.id } });
    expect(history).toBeTruthy();
    expect(history!.status).toBe("COMPLETED");
    expect(history!.buyerId).toBe(userC.id);
    expect(history!.sellerId).toBe(userD.id);
  });
});
