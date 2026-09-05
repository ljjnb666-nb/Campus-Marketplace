import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

/** 经真实服务层注销账号（integration 用；不经过 PrivacyRequest 流程）。 */
async function eraseAccountPublic(userId: string): Promise<void> {
  const { eraseAccount } = await import("@/lib/privacy/account-erasure");
  await eraseAccount(userId);
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
    // 订单/义务类（含竞态测试创建、未登记 orderNo 的行）：按参与方清理
    await rawClient!.order.deleteMany({
      where: { OR: [{ buyerId: { in: createdUserIds } }, { sellerId: { in: createdUserIds } }] },
    });
    await rawClient!.rentalOrder.deleteMany({
      where: {
        OR: [
          { ownerId: { in: createdUserIds } },
          { renterId: { in: createdUserIds } },
          { rentalListing: { category: { slug: { startsWith: "rental-race-" } } } },
        ],
      },
    });
    await rawClient!.errandTask.deleteMany({
      where: { OR: [{ publisherId: { in: createdUserIds } }, { accepterId: { in: createdUserIds } }] },
    });
    // listing 按参与方 + 按 race 专用分类双保险（历史失败运行可能遗留
    // 不同参与方的孤儿行，若仅按参与方清理会让分类删除持续撞 FK）
    await rawClient!.product.deleteMany({
      where: {
        OR: [
          { sellerId: { in: createdUserIds } },
          { category: { slug: { startsWith: "race-" } } },
        ],
      },
    });
    await rawClient!.serviceListing.deleteMany({
      where: {
        OR: [
          { providerId: { in: createdUserIds } },
          { category: { slug: { startsWith: "service-race-" } } },
        ],
      },
    });
    await rawClient!.rentalListing.deleteMany({
      where: {
        OR: [
          { ownerId: { in: createdUserIds } },
          { category: { slug: { startsWith: "rental-race-" } } },
        ],
      },
    });
    await rawClient!.errandTask.deleteMany({
      where: { category: { slug: { startsWith: "errand-race-" } } },
    });
    await rawClient!.productCategory.deleteMany({ where: { slug: { startsWith: "race-" } } });
    await rawClient!.rentalCategory.deleteMany({ where: { slug: { startsWith: "rental-race-" } } });
    await rawClient!.serviceCategory.deleteMany({ where: { slug: { startsWith: "service-race-" } } });
    await rawClient!.errandCategory.deleteMany({ where: { slug: { startsWith: "errand-race-" } } });
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

  it("SYNC_EXPORT_REQUEST_COMPLETES_TEST：一次同步导出恰好形成一条 COMPLETED 请求", async () => {
    const { executeSynchronousDataExport } = await import("@/lib/privacy/data-export");

    const target = await createFixtureUser("同步导出");
    const orderNo = `${RUN_TAG}-SYNC1`;
    createdOrderNos.push(orderNo);
    await rawClient!.order.create({
      data: {
        orderNo,
        type: "PRODUCT",
        status: "COMPLETED",
        amount: "1.00",
        buyerId: target.id,
        sellerId: otherUserId,
      },
    });

    const result = await executeSynchronousDataExport(target.id);

    // 恰好一条 DATA_EXPORT 请求且 COMPLETED + completedAt
    const requests = await rawClient!.privacyRequest.findMany({
      where: { userId: target.id, type: "DATA_EXPORT" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.id).toBe(result.request.id);
    expect(requests[0]!.status).toBe("COMPLETED");
    expect(requests[0]!.completedAt).toBeTruthy();

    // 载荷 + 请求元数据一起返回
    expect(result.payload.account.id).toBe(target.id);
    expect(result.payload.orders.some((order) => order.orderNo === orderNo)).toBe(true);
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

  it("对照说明：无锁时 READ COMMITTED 仅能看见已提交的 hold（这不是 serialization boundary）", async () => {
    // 本用例保留为对照证据：无锁事务内的 hold 检查只能检测"检查时点已提交"
    // 的 hold，check→commit 窗口内的并发 hold 创建不被拦截。
    // 真正的 serialization boundary 由下方 HOLD_ERASURE_POST_CHECK_RACE_TEST
    // 在 subject advisory 锁下证明。
    const { assertNoActiveHold } = await import("@/lib/privacy/data-hold-service");
    const { withTransaction } = await import("@/lib/prisma");

    const target = await createFixtureUser("对照目标");

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
  // BLOCKER 1 REPAIR — HOLD / ERASURE 真实 TOCTOU（subject advisory lock）
  // ============================================================

  /**
   * 线性化证明（对每个 hold 类型各测一次）：
   * erase 在 barrier seam（已取 subject 锁 + 前置检查全过、尚未写）处
   * 并发发起 createHold —— 该 createHold 必须阻塞在 subject 锁上直到
   * erase 事务提交；因此"hold 已提交而 erase 未见 hold 即提交"不可能。
   * 唯一合法序列：erase 先完成 → hold 创建随后发生（结果 1）。
   */
  async function runHoldErasureRaceTest(holdType: "LEGAL" | "DISPUTE"): Promise<void> {
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    const { createHold } = await import("@/lib/privacy/data-hold-service");

    const target = await createFixtureUser(`锁竞态${holdType}`);
    let racePointEntered = false;
    let holdSettled = false;
    let holdPromise: Promise<void> = Promise.resolve();

    const racePoint = async () => {
      racePointEntered = true;

      // 并发 createHold：需要同一把 subject 锁 → 阻塞到 erase 事务结束
      holdPromise = createHold({
        type: holdType,
        subjectId: target.id,
        reasonCode: `RACE_${holdType}_HOLD`,
      }).then(
        (hold) => {
          holdSettled = true;
          holdIds.push(hold.id);
        },
        () => {
          holdSettled = true;
        },
      );

      // sleep 仅观察"hold 仍被 subject 锁阻塞"（非 settlement 观察）；
      // 顺序由本 racePoint callback（seam 内 spawn）显式建立
      await new Promise((resolve) => setTimeout(resolve, 200));
      // sleep 仅观察“另一事务仍被锁阻塞”（非 settlement 观察）；
      // 顺序由本 racePoint callback（seam 内 spawn）显式建立

      // 关键断言：erase 持锁期间并发 hold 不可能完成创建（未被 erase 看到）
      expect(holdSettled).toBe(false);

      // 不在事务内 await holdPromise（会死锁）；返回后 erase 继续提交
    };

    const result = await eraseAccount(target.id, undefined, racePoint);

    expect(racePointEntered).toBe(true);
    expect(result.erasedAt).toBeTruthy();

    // erase 提交（锁释放）之后，被阻塞的 hold 才完成创建
    await holdPromise;
    expect(holdSettled).toBe(true);

    const hold = await rawClient!.dataHold.findFirst({
      where: { subjectId: target.id, type: holdType, reasonCode: `RACE_${holdType}_HOLD` },
    });
    expect(hold).toBeTruthy();
    expect(hold!.status).toBe("ACTIVE");
    // 线性化顺序：hold 创建时间不早于 erase 完成时间
    expect(hold!.createdAt.getTime()).toBeGreaterThanOrEqual(result.erasedAt.getTime());
  }

  it("HOLD_ERASURE_POST_CHECK_RACE_TEST（LEGAL）：erase 持锁期间并发 createHold 被阻塞到 erase 提交之后", async () => {
    await runHoldErasureRaceTest("LEGAL");
  });

  it("HOLD_ERASURE_POST_CHECK_RACE_TEST（DISPUTE）：同一线性化契约对 DISPUTE hold 成立", async () => {
    await runHoldErasureRaceTest("DISPUTE");
  });

  it("releaseHold 与 erase 共享 subject 锁：release 线性化在 erase 之前 → erase 放行并完成", async () => {
    const { createHold, releaseHold } = await import("@/lib/privacy/data-hold-service");
    const { createAccountDeletionRequest } = await import(
      "@/lib/privacy/privacy-request-service"
    );

    const target = await createFixtureUser("release锁序");
    const hold = await createHold({
      type: "DISPUTE",
      subjectId: target.id,
      reasonCode: "RELEASE_ORDER_HOLD",
    });
    holdIds.push(hold.id);

    // release 经同一把 subject 锁提交：之后 erase 必然看到 hold 已 RELEASED
    const released = await releaseHold(hold.id);
    expect(released.status).toBe("RELEASED");

    const outcome = await createAccountDeletionRequest(target.id);

    // release 线性化在 erase 之前 → 删除路径放行且完成
    expect(outcome.status).toBe("COMPLETED");
  });

  // ============================================================
  // BLOCKER 4 REPAIR — POLICY PUBLISH / ACCEPTANCE 真实竞态
  // ============================================================

  it("POLICY_PUBLISH_ACCEPTANCE_RACE_TEST：acceptance 持锁期间并发 publish 被阻塞到其提交之后（线性化 A）", async () => {
    const { createLegalDocument, publishLegalDocument } = await import(
      "@/lib/legal/legal-document-service"
    );
    const { getRequiredPolicies, getUserAcceptanceStatus, recordAcceptances } = await import(
      "@/lib/legal/policy-service"
    );

    const user = await createFixtureUser("政策竞态A");
    const rulesBase = await nextVersion("PLATFORM_RULES");

    const v1 = await publishLegalDocument(
      (
        await createLegalDocument({
          type: "PLATFORM_RULES",
          version: rulesBase,
          title: `竞态规则 v1 ${RUN_TAG}`,
          content: `竞态规则 v1 ${RUN_TAG}`,
        })
      ).id,
    );
    createdDocumentIds.push(v1.id);

    // v2 草稿（尚未发布）
    const v2 = await createLegalDocument({
      type: "PLATFORM_RULES",
      version: rulesBase + 1,
      title: `竞态规则 v2 ${RUN_TAG}`,
      content: `竞态规则 v2 ${RUN_TAG}`,
    });
    createdDocumentIds.push(v2.id);

    let publishSettled = false;
    let acceptanceInRace = false;

    // barrier：acceptance 在锁内（resolve/validate 完成、未写）时暂停；
    // 并发 publish 需要 PLATFORM_RULES 的 policy 锁 → 必须阻塞
    const racePoint = async () => {
      acceptanceInRace = true;

      void publishLegalDocument(v2.id).then(() => {
        publishSettled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
      // sleep 仅观察“另一事务仍被锁阻塞”（非 settlement 观察）；
      // 顺序由本 racePoint callback（seam 内 spawn）显式建立

      // acceptance 持 policy 锁期间，publish 不可能完成
      expect(publishSettled).toBe(false);
    };

    // 只提交唯一的 pending（TERMS v1 仍在 required、rules v1 是当前）——
    // 全集提交
    const submittedIds = (await getRequiredPolicies()).map((entry) => entry.id);
    const result = await recordAcceptances({
      userId: user.id,
      documentIds: submittedIds,
      source: "RECONSENT",
      racePoint,
    });

    expect(acceptanceInRace).toBe(true);
    expect(result.created).toBeGreaterThan(0);

    // acceptance 提交（锁释放）后，被阻塞的 publish 才完成（线性化 A：
    // v1 同意成功在先，publish v2 随后发生）
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect
      .poll(() => publishSettled, { timeout: 5_000 })
      .toBe(true);

    const published2 = await rawClient!.legalDocument.findUnique({ where: { id: v2.id } });
    expect(published2!.status).toBe("PUBLISHED");
    expect(published2!.publishedAt!.getTime()).toBeGreaterThanOrEqual(
      (await rawClient!.policyAcceptance.findFirstOrThrow({
        where: { userId: user.id, documentId: v1.id },
      })).acceptedAt.getTime(),
    );

    // 结果 A 的终态：publish 完成后用户对该新版本 OUTDATED（不是"已同意最新"）
    const status = await getUserAcceptanceStatus(user.id);
    expect(status.compliant).toBe(false);
    expect(status.pending.find((entry) => entry.id === v2.id)?.state).toBe("OUTDATED");
  });

  it("POLICY_PUBLISH_ACCEPTANCE_RACE_TEST（反向）：publish 先完成 → stale acceptance 被拒绝（线性化 B）", async () => {
    const { createLegalDocument, publishLegalDocument } = await import(
      "@/lib/legal/legal-document-service"
    );
    const { getRequiredPolicies, getUserAcceptanceStatus, recordAcceptances } = await import(
      "@/lib/legal/policy-service"
    );
    const { GovernanceError } = await import("@/lib/governance/domain-errors");

    const user = await createFixtureUser("政策竞态B");
    const base = await nextVersion("TERMS_OF_SERVICE");

    const v1 = await publishLegalDocument(
      (
        await createLegalDocument({
          type: "TERMS_OF_SERVICE",
          version: base,
          title: `竞态条款 v1 ${RUN_TAG}B`,
          content: `竞态条款 v1 ${RUN_TAG}B`,
        })
      ).id,
    );
    createdDocumentIds.push(v1.id);

    await recordAcceptances({
      userId: user.id,
      documentIds: (await getRequiredPolicies()).map((entry) => entry.id),
      source: "SIGNUP",
    });

    // publish v2 先完成（线性化在 acceptance 之前）
    const v2 = await publishLegalDocument(
      (
        await createLegalDocument({
          type: "TERMS_OF_SERVICE",
          version: base + 1,
          title: `竞态条款 v2 ${RUN_TAG}B`,
          content: `竞态条款 v2 ${RUN_TAG}B`,
        })
      ).id,
    );
    createdDocumentIds.push(v2.id);

    // stale 提交（v1）必须被拒
    await expect(
      recordAcceptances({ userId: user.id, documentIds: [v1.id], source: "RECONSENT" }),
    ).rejects.toBeInstanceOf(GovernanceError);

    const status = await getUserAcceptanceStatus(user.id);
    expect(status.compliant).toBe(false);
    expect(status.pending.find((entry) => entry.id === v2.id)?.state).toBe("OUTDATED");
  });

  it("CONCURRENT_POLICY_PUBLISH_SERIALIZATION_TEST：并发发布同 type vN/vN+1 不破坏版本顺序不变量", async () => {
    const { createLegalDocument, publishLegalDocument, getCurrentPublishedDocument } = await import(
      "@/lib/legal/legal-document-service"
    );

    const base = await nextVersion("PRIVACY_POLICY");
    const vN = await createLegalDocument({
      type: "PRIVACY_POLICY",
      version: base,
      title: `并发隐私 vN ${RUN_TAG}`,
      content: `并发隐私 vN ${RUN_TAG}`,
    });
    const vN1 = await createLegalDocument({
      type: "PRIVACY_POLICY",
      version: base + 1,
      title: `并发隐私 vN+1 ${RUN_TAG}`,
      content: `并发隐私 vN+1 ${RUN_TAG}`,
    });
    createdDocumentIds.push(vN.id, vN1.id);

    // 同一 type 的 vN / vN+1 并发发布（policy 锁串行化）
    const outcomes = await Promise.allSettled([
      publishLegalDocument(vN.id),
      publishLegalDocument(vN1.id),
    ]);

    const finalN = await rawClient!.legalDocument.findUnique({ where: { id: vN.id } });
    const finalN1 = await rawClient!.legalDocument.findUnique({ where: { id: vN1.id } });

    // vN+1 必然发布成功（无论锁序先后：先发则 vN 随后通过；后发则 vN 被拒）
    expect(finalN1!.status).toBe("PUBLISHED");
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);

    if (finalN!.status === "PUBLISHED") {
      // vN 也成功 → 它一定先于 vN+1（版本顺序契约）
      expect(finalN!.publishedAt!.getTime()).toBeLessThanOrEqual(
        finalN1!.publishedAt!.getTime(),
      );
    } else {
      // vN 被版本顺序 invariant 拒绝（vN+1 已先发布）
      expect(finalN!.status).toBe("DRAFT");
    }

    // 最终 current 唯一且确定：vN+1
    const current = await getCurrentPublishedDocument("PRIVACY_POLICY", new Date());
    expect(current!.id).toBe(vN1.id);
    expect(current!.version).toBe(base + 1);
  });

  // ============================================================
  // ============================================================
  // BLOCKER A REPAIR 2 — 导出失败台账必须持久化（不被事务回滚吞掉）
  // ============================================================

  it("SYNC_EXPORT_FAILURE_PERSISTS_REJECTED_TEST CASE1：TOO_LARGE → 恰一条 REJECTED 台账（真实提交）", async () => {
    const { executeSynchronousDataExport } = await import("@/lib/privacy/data-export");
    const { governanceError, GovernanceError } = await import(
      "@/lib/governance/domain-errors"
    );

    const target = await createFixtureUser("导出失败-超限");

    // deterministic seam：注入的 builder 强制抛 TOO_LARGE
    await expect(
      executeSynchronousDataExport(target.id, async () => {
        throw governanceError("DATA_EXPORT_TOO_LARGE");
      }),
    ).rejects.toBeInstanceOf(GovernanceError);

    // 新连接查询 DB：REJECTED 台账真实持久化（没有被事务回滚吞掉）
    const requests = await rawClient!.privacyRequest.findMany({
      where: { userId: target.id, type: "DATA_EXPORT" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.status).toBe("REJECTED");
    expect(requests[0]!.reasonCode).toBe("DATA_EXPORT_TOO_LARGE");
    expect(requests[0]!.completedAt).toBeNull();
  });

  it("SYNC_EXPORT_FAILURE_PERSISTS_REJECTED_TEST CASE2：执行失败 → 恰一条 REJECTED 台账 + 原错误上抛", async () => {
    const { executeSynchronousDataExport } = await import("@/lib/privacy/data-export");

    const target = await createFixtureUser("导出失败-异常");

    const boom = new Error("boom: controlled export execution failure");

    await expect(
      executeSynchronousDataExport(target.id, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const requests = await rawClient!.privacyRequest.findMany({
      where: { userId: target.id, type: "DATA_EXPORT" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.status).toBe("REJECTED");
    expect(requests[0]!.reasonCode).toBe("EXPORT_EXECUTION_FAILED");
    expect(requests[0]!.completedAt).toBeNull();
  });

  // ============================================================
  // BLOCKER B REPAIR 2 — obligation 创建 vs 账号注销竞态
  // ============================================================

  async function createOrderFixtures() {
    const buyer = await createFixtureUser("下单买家");
    const seller = await createFixtureUser("卖家");
    const category = await rawClient!.productCategory.create({
      data: { name: `竞态分类 ${RUN_TAG}`, slug: `race-${randomUUID().slice(0, 8)}` },
    });
    const product = await rawClient!.product.create({
      data: {
        title: `竞态商品 ${RUN_TAG}`,
        description: "participant guard 竞态测试商品",
        price: "10.00",
        locationText: "IT 测试点",
        condition: "NEW",
        status: "ACTIVE",
        sellerId: seller.id,
        campusId: (await rawClient!.campus.findUniqueOrThrow({ where: { slug: "it-main-campus" } })).id,
        categoryId: category.id,
      },
    });

    return { buyer, seller, product };
  }

  it("ORDER_CREATION_ERASURE_RACE_TEST 方向A：order 先取锁 → 注销被阻塞 → 订单提交后注销 BLOCKED", { timeout: 20_000 }, async () => {
    const { withTransaction } = await import("@/lib/prisma");
    const { createProductOrderTx } = await import("@/lib/order-creation");
    const { createAccountDeletionRequest } = await import(
      "@/lib/privacy/privacy-request-service"
    );

    const { buyer, product } = await createOrderFixtures();
    let eraseSettled = false;
    let eraseOutcome: unknown;

    // order 事务持 participant 锁，在 seam 处暂停；并发注销被锁阻塞
    const racePoint = async () => {
      void createAccountDeletionRequest(buyer.id).then(
        (outcome) => {
          eraseSettled = true;
          eraseOutcome = outcome;
        },
        (error) => {
          eraseSettled = true;
          eraseOutcome = error;
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      // sleep 仅观察“另一事务仍被锁阻塞”（非 settlement 观察）；
      // 顺序由本 racePoint callback（seam 内 spawn）显式建立

      // order 持锁期间注销不可能完成（未看到新订单）
      expect(eraseSettled).toBe(false);
    };

    const order = await withTransaction((tx) =>
      createProductOrderTx(
        tx,
        {
          buyerId: buyer.id,
          product: { id: product.id, price: "10.00", sellerId: product.sellerId },
          meetingLocation: "IT 测试点",
          note: null,
        },
        racePoint,
      ),
    );

    expect(order).toBeTruthy();

    // order 提交后注销才取得锁 → active-transaction 检查看到 PENDING 订单 → BLOCKED
    await vi.waitFor(() => expect(eraseSettled).toBe(true), { timeout: 10_000 });
    expect((eraseOutcome as { status?: string }).status).toBe("BLOCKED");
    expect((eraseOutcome as { request?: { reasonCode?: string } }).request?.reasonCode).toBe(
      "ACTIVE_TRANSACTION_BLOCK",
    );

    // 不变量：买家未注销且持有 active 订单（被正确阻断），不存在"已注销 + active 订单"
    const buyerRow = await rawClient!.user.findUniqueOrThrow({ where: { id: buyer.id } });
    expect(buyerRow.erasedAt).toBeNull();
    const orders = await rawClient!.order.findMany({ where: { buyerId: buyer.id } });
    expect(orders).toHaveLength(1);
  });

  it("ORDER_CREATION_ERASURE_RACE_TEST 方向B：erase 先取锁 → 订单等锁醒来 → participant 复核失败 → 零新订单", async () => {
    const { withTransaction } = await import("@/lib/prisma");
    const { createProductOrderTx } = await import("@/lib/order-creation");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    const { GovernanceError } = await import("@/lib/governance/domain-errors");

    const { buyer, product } = await createOrderFixtures();

    // erase 先取得 subject 锁并在 seam 暂停（锁已持有、尚未写）。
    // 双 barrier：entered 由 production seam callback 主动 signal——await 后
    // 100% 确定 erase 已持有 subject lock 并到达 racePoint；gate 由测试控制
    // 放行。竞态顺序由协议显式建立，不依赖机器速度。
    let signalEraseEntered!: () => void;
    let releaseErase!: () => void;
    const eraseEntered = new Promise<void>((resolve) => {
      signalEraseEntered = resolve;
    });
    const eraseGate = new Promise<void>((resolve) => {
      releaseErase = resolve;
    });
    let eraseRaceEnteredCount = 0;

    const erasePromise = eraseAccount(buyer.id, undefined, async () => {
      eraseRaceEnteredCount += 1;
      signalEraseEntered();
      await eraseGate;
    });

    // barrier：erase 已确定进入 seam（seam entered exactly once 见下方断言）
    await eraseEntered;
    expect(eraseRaceEnteredCount).toBe(1);

    let orderSettled = false;
    // 创建时即捕获结果（ok/err 联合）：rejected promise 永不裸露，
    // 消除 unhandled rejection 窗口
    const orderOutcome = withTransaction((tx) =>
      createProductOrderTx(tx, {
        buyerId: buyer.id,
        product: { id: product.id, price: "10.00", sellerId: product.sellerId },
        meetingLocation: "IT 测试点",
        note: null,
      }),
    ).then(
      (order) => {
        orderSettled = true;
        return { ok: true as const, order };
      },
      (error) => {
        orderSettled = true;
        return { ok: false as const, error };
      },
    );

    // sleep 仅观察"订单仍被 advisory 阻塞"这一事实；顺序已由 entered barrier 显式确立
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(orderSettled).toBe(false);

    releaseErase!();
    await erasePromise;

    // 订单事务醒来 → participant 复核失败 → 创建被拒
    const orderResult = await orderOutcome;
    expect(orderResult.ok).toBe(false);
    expect((orderResult as { error: unknown }).error).toBeInstanceOf(GovernanceError);

    // 不变量：账号已注销 + 零 active 订单
    const buyerRow = await rawClient!.user.findUniqueOrThrow({ where: { id: buyer.id } });
    expect(buyerRow.erasedAt).toBeTruthy();
    const orders = await rawClient!.order.findMany({ where: { buyerId: buyer.id } });
    expect(orders).toHaveLength(0);
  });

  it("RENTAL_CREATION_ERASURE_RACE_TEST 方向A：rental 先取锁 → 提交后注销 BLOCKED", { timeout: 20_000 }, async () => {
    const { withTransaction } = await import("@/lib/prisma");
    const { createRentalOrderTx } = await import("@/lib/rental-order-machine");
    const { createAccountDeletionRequest } = await import(
      "@/lib/privacy/privacy-request-service"
    );

    const owner = await createFixtureUser("出租者");
    const renter = await createFixtureUser("租客");
    const campusId = (
      await rawClient!.campus.findUniqueOrThrow({ where: { slug: "it-main-campus" } })
    ).id;
    const category = await rawClient!.rentalCategory.create({
      data: { name: `竞态租赁分类 ${RUN_TAG}`, slug: `rental-race-${randomUUID().slice(0, 8)}` },
    });
    const listing = await rawClient!.rentalListing.create({
      data: {
        title: `竞态租赁 ${RUN_TAG}`,
        description: "participant guard 竞态测试物品",
        condition: "NEW",
        price: "20.00",
        pricingUnit: "PER_DAY",
        depositAmount: "50.00",
        minimumDuration: 1,
        maximumDuration: 30,
        totalQuantity: 1,
        availableQuantity: 1,
        pickupLocation: "IT 南门",
        returnLocation: "IT 南门",
        status: "AVAILABLE",
        ownerId: owner.id,
        campusId,
        categoryId: category.id,
      },
    });

    const startTime = new Date(Date.now() + 24 * 3600 * 1000);
    const endTime = new Date(Date.now() + 48 * 3600 * 1000);

    let eraseSettled = false;
    let eraseOutcome: unknown;

    const racePoint = async () => {
      void createAccountDeletionRequest(renter.id).then(
        (outcome) => {
          eraseSettled = true;
          eraseOutcome = outcome;
        },
        (error) => {
          eraseSettled = true;
          eraseOutcome = error;
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      // sleep 仅观察“另一事务仍被锁阻塞”（非 settlement 观察）；
      // 顺序由本 racePoint callback（seam 内 spawn）显式建立

      expect(eraseSettled).toBe(false);
    };

    const result = await withTransaction((tx) =>
      createRentalOrderTx(
        tx,
        {
          userId: renter.id,
          rentalListingId: listing.id,
          startTime,
          endTime,
          quantity: 1,
        },
        racePoint,
      ),
    );

    expect("orderId" in result && typeof result.orderId === "string").toBe(true);

    // 租赁提交后注销才拿到锁 → PENDING_APPROVAL 租赁订单 → BLOCKED
    await vi.waitFor(() => expect(eraseSettled).toBe(true), { timeout: 10_000 });
    expect((eraseOutcome as { status?: string }).status).toBe("BLOCKED");
    expect((eraseOutcome as { request?: { reasonCode?: string } }).request?.reasonCode).toBe(
      "ACTIVE_TRANSACTION_BLOCK",
    );

    // 不变量：租客未注销且持有 active 租赁义务
    const renterRow = await rawClient!.user.findUniqueOrThrow({ where: { id: renter.id } });
    expect(renterRow.erasedAt).toBeNull();
    const rentalOrders = await rawClient!.rentalOrder.findMany({ where: { renterId: renter.id } });
    expect(rentalOrders).toHaveLength(1);
  });

  it("RENTAL_CREATION_ERASURE_RACE_TEST 方向B：erase 先取锁 → 租赁等锁醒来 → 复核失败 → 零新租赁", async () => {
    const { withTransaction } = await import("@/lib/prisma");
    const { createRentalOrderTx } = await import("@/lib/rental-order-machine");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    const { GovernanceError } = await import("@/lib/governance/domain-errors");

    const owner = await createFixtureUser("出租者B");
    const renter = await createFixtureUser("租客B");
    const campusId = (
      await rawClient!.campus.findUniqueOrThrow({ where: { slug: "it-main-campus" } })
    ).id;
    const category = await rawClient!.rentalCategory.create({
      data: { name: `竞态租赁分类B ${RUN_TAG}`, slug: `rental-race-b-${randomUUID().slice(0, 8)}` },
    });
    const listing = await rawClient!.rentalListing.create({
      data: {
        title: `竞态租赁B ${RUN_TAG}`,
        description: "participant guard 竞态测试物品",
        condition: "NEW",
        price: "20.00",
        pricingUnit: "PER_DAY",
        depositAmount: "50.00",
        minimumDuration: 1,
        maximumDuration: 30,
        totalQuantity: 1,
        availableQuantity: 1,
        pickupLocation: "IT 南门",
        returnLocation: "IT 南门",
        status: "AVAILABLE",
        ownerId: owner.id,
        campusId,
        categoryId: category.id,
      },
    });

    // 双 barrier：entered 由 production seam callback 主动 signal——await 后
    // 100% 确定 erase 已持有 renter subject lock 并到达 racePoint；gate 由
    // 测试控制放行。竞态顺序由协议显式建立，不依赖机器速度。
    let signalEraseEntered!: () => void;
    let releaseErase!: () => void;
    const eraseEntered = new Promise<void>((resolve) => {
      signalEraseEntered = resolve;
    });
    const eraseGate = new Promise<void>((resolve) => {
      releaseErase = resolve;
    });
    let eraseRaceEnteredCount = 0;

    const erasePromise = eraseAccount(renter.id, undefined, async () => {
      eraseRaceEnteredCount += 1;
      signalEraseEntered();
      await eraseGate;
    });

    // barrier：erase 已确定进入 seam（seam entered exactly once 见下方断言）
    await eraseEntered;
    expect(eraseRaceEnteredCount).toBe(1);

    let rentalSettled = false;
    // 创建时即捕获结果：rejected promise 永不裸露
    const rentalOutcome = withTransaction((tx) =>
      createRentalOrderTx(tx, {
        userId: renter.id,
        rentalListingId: listing.id,
        startTime: new Date(Date.now() + 24 * 3600 * 1000),
        endTime: new Date(Date.now() + 48 * 3600 * 1000),
        quantity: 1,
      }),
    ).then(
      (result) => {
        rentalSettled = true;
        return { ok: true as const, result };
      },
      (error) => {
        rentalSettled = true;
        return { ok: false as const, error };
      },
    );

    // sleep 仅观察"租赁仍被 advisory 阻塞"；顺序已由 entered barrier 显式确立
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(rentalSettled).toBe(false);

    releaseErase!();
    await erasePromise;

    const rentalResult = await rentalOutcome;
    expect(rentalResult.ok).toBe(false);
    expect((rentalResult as { error: unknown }).error).toBeInstanceOf(GovernanceError);

    const renterRow = await rawClient!.user.findUniqueOrThrow({ where: { id: renter.id } });
    expect(renterRow.erasedAt).toBeTruthy();
    const rentalOrders = await rawClient!.rentalOrder.findMany({ where: { renterId: renter.id } });
    expect(rentalOrders).toHaveLength(0);
  });

  // ============================================================
  // BLOCKER REPAIR 3 — OWNER-side 锁序（listing FOR UPDATE ↔ subject lock
  // 交叉反转会造成 PostgreSQL 40P01 死锁）。修复后锁序：
  //   pre-read（无锁）→ subject locks → FOR UPDATE → 行锁下重验证 → 写入
  // ============================================================

  async function createOwnerSideRentalFixture() {
    const owner = await createFixtureUser("出租者-锁序");
    const renter = await createFixtureUser("租客-锁序");
    const campusId = (
      await rawClient!.campus.findUniqueOrThrow({ where: { slug: "it-main-campus" } })
    ).id;
    const category = await rawClient!.rentalCategory.create({
      data: {
        name: `锁序租赁分类 ${RUN_TAG}`,
        slug: `rental-race-lock-${randomUUID().slice(0, 8)}`,
      },
    });
    const listing = await rawClient!.rentalListing.create({
      data: {
        title: `锁序租赁 ${RUN_TAG}`,
        description: "owner-side 锁序回归物品",
        condition: "NEW",
        price: "20.00",
        pricingUnit: "PER_DAY",
        depositAmount: "50.00",
        minimumDuration: 1,
        maximumDuration: 30,
        totalQuantity: 1,
        availableQuantity: 1,
        pickupLocation: "IT 南门",
        returnLocation: "IT 南门",
        status: "AVAILABLE",
        ownerId: owner.id,
        campusId,
        categoryId: category.id,
      },
    });

    return { owner, renter, listing };
  }

  it("RENTAL_OWNER_CREATION_ERASURE_RACE_TEST_DIRECTION_A：rental 先取 subject 锁 → owner 注销被阻塞 → 提交后 BLOCKED（无 40P01）", { timeout: 20_000 }, async () => {
    const { withTransaction } = await import("@/lib/prisma");
    const { createRentalOrderTx } = await import("@/lib/rental-order-machine");
    const { createAccountDeletionRequest } = await import(
      "@/lib/privacy/privacy-request-service"
    );

    const { owner, renter, listing } = await createOwnerSideRentalFixture();

    let eraseSettled = false;
    let eraseOutcome: unknown;

    // rental 先取得 owner+renter subject 锁，在 seam 暂停（FOR UPDATE 之前）；
    // owner 注销必须阻塞在 USER:owner advisory lock 上
    const racePoint = async () => {
      void createAccountDeletionRequest(owner.id).then(
        (outcome) => {
          eraseSettled = true;
          eraseOutcome = outcome;
        },
        (error) => {
          eraseSettled = true;
          eraseOutcome = error;
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      // sleep 仅观察“另一事务仍被锁阻塞”（非 settlement 观察）；
      // 顺序由本 racePoint callback（seam 内 spawn）显式建立

      // rental 持锁期间 owner 注销不可能完成
      expect(eraseSettled).toBe(false);
    };

    const result = await withTransaction((tx) =>
      createRentalOrderTx(
        tx,
        {
          userId: renter.id,
          rentalListingId: listing.id,
          startTime: new Date(Date.now() + 24 * 3600 * 1000),
          endTime: new Date(Date.now() + 48 * 3600 * 1000),
          quantity: 1,
        },
        racePoint,
      ),
    );

    expect("orderId" in result && typeof result.orderId === "string").toBe(true);

    // rental 提交后 owner 注销才醒来 → active RentalOrder 检查命中 → BLOCKED。
    // 若发生 40P01 死锁，erase 会以异常 settle——此处 outcome 必须是正常结果。
    try {
      await vi.waitFor(() => expect(eraseSettled).toBe(true), { timeout: 12_000 });
    } catch (error) {
      // 诊断：advisory 等待不被 PG 死锁检测覆盖，超时时打印等待图定位阻塞源
      const activity = await rawClient!.$queryRaw<
        Array<{ pid: number; state: string; wait_event_type: string | null; wait_event: string | null; query: string }>
      >`SELECT pid, state, wait_event_type, wait_event, left(query, 120) AS query
        FROM pg_stat_activity
        WHERE datname = current_database() AND state <> 'idle'`;
      console.log("DIAG pg_stat_activity:", JSON.stringify(activity, null, 1));
      throw error;
    }
    expect(eraseOutcome).not.toBeInstanceOf(Error);
    expect((eraseOutcome as { status?: string }).status).toBe("BLOCKED");
    expect((eraseOutcome as { request?: { reasonCode?: string } }).request?.reasonCode).toBe(
      "ACTIVE_TRANSACTION_BLOCK",
    );

    // 最终不变量
    const ownerRow = await rawClient!.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(ownerRow.erasedAt).toBeNull();
    const rentalOrders = await rawClient!.rentalOrder.findMany({ where: { ownerId: owner.id } });
    expect(rentalOrders).toHaveLength(1);
    expect(["PENDING_APPROVAL", "PENDING_PICKUP"]).toContain(rentalOrders[0]!.status);
  });

  it("RENTAL_OWNER_CREATION_ERASURE_RACE_TEST_DIRECTION_B：owner erase 先取锁 → rental 等锁（未持 listing 行锁）→ 复核失败零订单", { timeout: 20_000 }, async () => {
    const { withTransaction } = await import("@/lib/prisma");
    const { createRentalOrderTx } = await import("@/lib/rental-order-machine");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    const { GovernanceError } = await import("@/lib/governance/domain-errors");

    const { owner, renter, listing } = await createOwnerSideRentalFixture();

    // owner erase 先取得 USER:owner subject 锁，在其 seam 暂停（尚未写）。
    // 双 barrier：entered 由 production seam callback 主动 signal——await 后
    // 100% 确定 owner erase 已持有 subject lock 并到达 racePoint；gate 由
    // 测试控制放行。这是本轮最关键的一条：rental 必须在 erase 已持锁的
    // 确定性前提下启动，"rental 未持 listing FOR UPDATE"才可被严格证明。
    let signalEraseEntered!: () => void;
    let releaseErase!: () => void;
    const eraseEntered = new Promise<void>((resolve) => {
      signalEraseEntered = resolve;
    });
    const eraseGate = new Promise<void>((resolve) => {
      releaseErase = resolve;
    });
    let eraseRaceEnteredCount = 0;

    const erasePromise = eraseAccount(owner.id, undefined, async () => {
      eraseRaceEnteredCount += 1;
      signalEraseEntered();
      await eraseGate;
    });

    // barrier：erase 已确定进入 seam（seam entered exactly once 见下方断言）
    await eraseEntered;
    expect(eraseRaceEnteredCount).toBe(1);

    let rentalSettled = false;
    // 创建时即捕获结果：rejected promise 永不裸露（release 后 rental 会在
    // erase 提交期间醒来并失败——捕获必须先行，避免 unhandled 窗口）
    const rentalOutcome = withTransaction((tx) =>
      createRentalOrderTx(tx, {
        userId: renter.id,
        rentalListingId: listing.id,
        startTime: new Date(Date.now() + 24 * 3600 * 1000),
        endTime: new Date(Date.now() + 48 * 3600 * 1000),
        quantity: 1,
      }),
    ).then(
      (result) => {
        rentalSettled = true;
        return { ok: true as const, result };
      },
      (error) => {
        rentalSettled = true;
        return { ok: false as const, error };
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    // rental 阻塞在 subject lock 上——此时它不得已持有 RentalListing FOR UPDATE
    // （旧锁序下此处会形成死锁：erase 的 OFFLINE update 等行锁、rental 等
    // advisory lock，双方 40P01）。下面 release 后 erase 能顺利完成更新即
    // 是"rental 未持行锁"的直接行为证明。
    expect(rentalSettled).toBe(false);

    releaseErase!();
    await erasePromise;

    // erase 已将 owner 的 listing 下架并提交（无行锁争用/死锁）
    const listingRow = await rawClient!.rentalListing.findUniqueOrThrow({
      where: { id: listing.id },
    });
    expect(listingRow.status).toBe("OFFLINE");

    // rental 醒来 → participant active recheck 失败 → GOVERNANCE_SUBJECT_INACTIVE
    const rentalResult = await rentalOutcome;
    expect(rentalResult.ok).toBe(false);
    const rejection = (rentalResult as { error: unknown }).error;
    expect(rejection).toBeInstanceOf(GovernanceError);
    expect((rejection as { code?: string }).code).toBe("GOVERNANCE_SUBJECT_INACTIVE");
    // 不得出现 SQLSTATE 40P01 / deadlock detected
    expect(String((rejection as { message?: string })?.message ?? "")).not.toMatch(
      /deadlock|40P01/i,
    );

    // 最终不变量
    const ownerRow = await rawClient!.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(ownerRow.erasedAt).toBeTruthy();
    const rentalOrders = await rawClient!.rentalOrder.findMany({ where: { ownerId: owner.id } });
    expect(rentalOrders).toHaveLength(0);
  });

  it("SERVICE_ORDER_AUDIT：erased participant → 服务预约被拒且零新订单", async () => {
    const { withTransaction } = await import("@/lib/prisma");
    const { createServiceOrderTx } = await import("@/lib/order-creation");
    const { GovernanceError } = await import("@/lib/governance/domain-errors");

    const buyer = await createFixtureUser("服务买家");
    const provider = await createFixtureUser("服务提供者");
    const campusId = (
      await rawClient!.campus.findUniqueOrThrow({ where: { slug: "it-main-campus" } })
    ).id;
    const category = await rawClient!.serviceCategory.create({
      data: { name: `竞态服务分类 ${RUN_TAG}`, slug: `service-race-${randomUUID().slice(0, 8)}` },
    });
    const listing = await rawClient!.serviceListing.create({
      data: {
        title: `竞态服务 ${RUN_TAG}`,
        description: "guard 审计服务",
        price: "30.00",
        pricingUnit: "PER_SESSION",
        locationText: "IT 测试点",
        status: "ACTIVE",
        providerId: provider.id,
        campusId,
        categoryId: category.id,
      },
    });

    // 先注销 provider
    await eraseAccountPublic(provider.id);

    await expect(
      withTransaction((tx) =>
        createServiceOrderTx(tx, {
          buyerId: buyer.id,
          service: { id: listing.id, price: "30.00", providerId: provider.id },
          meetingLocation: "IT",
          note: null,
        }),
      ),
    ).rejects.toBeInstanceOf(GovernanceError);

    const orders = await rawClient!.order.findMany({ where: { sellerId: provider.id } });
    expect(orders).toHaveLength(0);
  });

  it("ERRAND_OBLIGATION_AUDIT：erased participant → 跑腿接单被拒且零新义务", async () => {
    const { withTransaction } = await import("@/lib/prisma");
    const { claimErrandTx } = await import("@/lib/order-creation");
    const { GovernanceError } = await import("@/lib/governance/domain-errors");

    const publisher = await createFixtureUser("跑腿发布者");
    const runner = await createFixtureUser("跑腿接单者");
    const campusId = (
      await rawClient!.campus.findUniqueOrThrow({ where: { slug: "it-main-campus" } })
    ).id;
    const category = await rawClient!.errandCategory.create({
      data: { name: `竞态跑腿分类 ${RUN_TAG}`, slug: `errand-race-${randomUUID().slice(0, 8)}` },
    });
    const errand = await rawClient!.errandTask.create({
      data: {
        title: `竞态跑腿 ${RUN_TAG}`,
        description: "guard 审计任务",
        reward: "15.00",
        pickupLocation: "IT 取件点",
        deliveryLocation: "IT 送达点",
        deadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        status: "OPEN",
        publisherId: publisher.id,
        campusId,
        categoryId: category.id,
      },
    });

    // 先注销 runner
    await eraseAccountPublic(runner.id);

    await expect(
      withTransaction((tx) =>
        claimErrandTx(tx, {
          errandId: errand.id,
          publisherId: publisher.id,
          claimerId: runner.id,
          reward: errand.reward,
        }),
      ),
    ).rejects.toBeInstanceOf(GovernanceError);

    // 零新义务：无 ACCEPTED 订单、任务保持 OPEN、无 accepter
    const orders = await rawClient!.order.findMany({ where: { sellerId: runner.id } });
    expect(orders).toHaveLength(0);
    const errandRow = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } });
    expect(errandRow.status).toBe("OPEN");
    expect(errandRow.accepterId).toBeNull();
  });

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
