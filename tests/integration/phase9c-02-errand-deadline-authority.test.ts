import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Phase 9C-02（ERRAND DEADLINE AUTHORITY）集成测试（真实 PostgreSQL）。
//
// 关闭的缺口：ErrandTask.deadline 此前只是 create/edit 的表单校验——
// 默认公开列表仅要求 status = OPEN，claimErrandTx 锁内 fresh 谓词不含
// deadline。因此 `deadline 已过 → ErrandTask 仍 OPEN` 时，任务仍可进入
// public discovery、仍可通过 canonical claim boundary 创建新的
// Order ACCEPTED 义务。
//
// 修复后合同（冻结，对应任务书 §1/§2/§4/§5/§6/§21/§22）：
//   - PUBLIC_EXPOSED = status OPEN AND deletedAt null AND deadline > now
//     AND moderation allows（errandPublicExposureFilter 单一查询口径）
//   - claim 权威在 participant 锁 → ErrandTask FOR UPDATE → fresh row
//     上判定 fresh.deadline <= now → DENY（零 Task/Order/Notification）
//   - deadline == now 属过期（严格大于边界）
//   - edit：current deadline 已过（row 尚未 materialize）→ DEADLINE_EXPIRED
//     零写，不得延长复活；请求的过去 deadline 一律拒绝
//   - CLAIMED → OPEN reopen：fresh deadline 已过 → false（既有 CLAIMED
//     obligation 原样保留，零 Task/Order/Notification）
//   - public correctness 不依赖 scheduler：过期 OPEN 任务在 AsyncJob 不
//     存在时就必须已从全部公开面消失（§21）
//   - owner 管理/历史面不受 deadline 影响（§22）
//
// 时钟：deadline 全部直接落库（TEST-ONLY DEADLINE ADVANCE）；claim 注入
// now 仅用于 == now 边界证明；零 sleep。

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const sessionSeam = vi.hoisted(() => ({
  actionUser: { current: null as null | { id: string; email: string; name: string } },
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser: async () => {
    if (!sessionSeam.actionUser.current) {
      throw new Error("NO_SESSION");
    }
    return sessionSeam.actionUser.current;
  },
  getActiveViewerId: async () => sessionSeam.actionUser.current?.id ?? null,
  getVerifiedSession: async () => {
    const current = sessionSeam.actionUser.current;
    return current ? { ok: true as const, user: current } : { ok: false as const };
  },
}));

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p9c02-${randomUUID().slice(0, 8)}`;
const CAMPUS_SLUG = `p9c02-${randomUUID().slice(0, 8)}`;

let campusId = "";
let errandCategoryId = "";

const userIds: string[] = [];
const errandIds: string[] = [];
const orderIds: string[] = [];
const favoriteIds: string[] = [];
const dedicatedCampusIds: string[] = [];

let fixtureSeq = 0;

async function createFixtureUser(name: string) {
  const seq = fixtureSeq++;
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${seq}-${name}@it.local`,
      name,
      passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
      schoolName: "集成测试大学",
      campusId,
      role: "STUDENT",
      status: "ACTIVE",
    },
  });
  userIds.push(user.id);
  await rawClient!.campusMembership.create({
    data: { userId: user.id, campusId, status: "ACTIVE" },
  });
  return user;
}

async function createErrandFixture(input: {
  publisherId: string;
  title: string;
  status?: "OPEN" | "CLAIMED";
  accepterId?: string | null;
  /** 相对当前的 deadline 偏移毫秒（负 = 过去）。 */
  deadlineOffsetMs?: number;
  /** 默认使用文件级 campus；homepage cache 隔离用例传专用 campus。 */
  campusIdOverride?: string;
}) {
  const errand = await rawClient!.errandTask.create({
    data: {
      title: input.title,
      description: `Phase 9C-02 deadline fixture ${RUN_TAG}`,
      reward: 10,
      pickupLocation: "东门",
      deliveryLocation: "西门",
      deadline: new Date(Date.now() + (input.deadlineOffsetMs ?? 60 * 60 * 1000)),
      categoryId: errandCategoryId,
      campusId: input.campusIdOverride ?? campusId,
      publisherId: input.publisherId,
      status: input.status ?? "OPEN",
      accepterId: input.accepterId ?? null,
    },
  });
  errandIds.push(errand.id);
  return errand;
}

/** 直接落库的 ACCEPTED ERRAND 订单（canonical pair fixture：Task CLAIMED ↔ Order ACCEPTED）。 */
async function createErrandOrderFixture(input: {
  publisherId: string;
  accepterId: string;
  errandTaskId: string;
}) {
  const order = await rawClient!.order.create({
    data: {
      orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
      type: "ERRAND",
      status: "ACCEPTED",
      paymentStatus: "OFFLINE_PENDING",
      amount: "10.00",
      buyerId: input.publisherId,
      sellerId: input.accepterId,
      errandTaskId: input.errandTaskId,
    },
  });
  orderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  if (!rawClient) return;

  const campus = await rawClient.campus.upsert({
    where: { slug: CAMPUS_SLUG },
    create: { name: `9C02 校区 ${randomUUID().slice(0, 6)}`, slug: CAMPUS_SLUG, schoolName: "集成测试大学" },
    update: {},
  });
  campusId = campus.id;

  const errandCategory = await rawClient.errandCategory.create({
    data: { name: `9C02跑腿类目-${RUN_TAG}`, slug: `p9c02-err-${RUN_TAG}` },
  });
  errandCategoryId = errandCategory.id;
});

afterAll(async () => {
  if (!rawClient) return;

  // 反向 FK 清理（精确 fixture ID 域；失败即抛——禁止吞错）
  await rawClient.notification.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.riskState.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.errandFavorite.deleteMany({ where: { id: { in: favoriteIds } } });
  await rawClient.order.deleteMany({ where: { id: { in: orderIds } } });
  await rawClient.errandTask.deleteMany({ where: { id: { in: errandIds } } });
  await rawClient.errandCategory.deleteMany({ where: { id: errandCategoryId } });
  await rawClient.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: userIds } } });
  await rawClient.campus.deleteMany({ where: { id: { in: [campusId, ...dedicatedCampusIds] } } });

  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 9C-02 errand deadline authority（真实 PostgreSQL）",
  () => {
    it("ERRAND-DEADLINE-PUBLIC-01（§6/§21/§22）：过期 OPEN（AsyncJob 不存在）从全部公开面消失；owner 管理面保留", async () => {
      const publisher = await createFixtureUser("PUBLIC发布者");
      const viewer = await createFixtureUser("PUBLIC浏览者");
      sessionSeam.actionUser.current = { id: viewer.id, email: `${RUN_TAG}@it.local`, name: "viewer" };

      const expired = await createErrandFixture({
        publisherId: publisher.id,
        title: `9C02过期曝光-${RUN_TAG}`,
        deadlineOffsetMs: -60_000,
      });
      const control = await createErrandFixture({
        publisherId: publisher.id,
        title: `9C02可见对照-${RUN_TAG}`,
        deadlineOffsetMs: 60 * 60 * 1000,
      });

      // 1. 默认公开列表（含 items/total 同一 now）
      const list = await (await import("@/repositories/errand-repository")).getErrandList({ q: RUN_TAG });
      const listIds = list.items.map((item) => item.id);
      expect(listIds).not.toContain(expired.id);
      expect(listIds).toContain(control.id);
      expect(list.total).toBe(1);

      // 2. 详情推荐池（同一 exposure contract）
      const { getErrandDetail } = await import("@/repositories/errand-repository");
      const detail = await getErrandDetail(control.id);
      expect(detail.relatedErrands.map((item) => item.id)).not.toContain(expired.id);

      // 3. homepage 两榜 + 公开计数
      const home = await import("@/repositories/home-repository");
      const errandSections = await home.getHomepageErrands({ campusId });
      expect(errandSections.urgentErrands.map((item) => item.id)).not.toContain(expired.id);
      expect(errandSections.highRewardErrands.map((item) => item.id)).not.toContain(expired.id);
      const summary = await home.getHomepageSummary({ campusId });
      expect(summary.errandCount).toBe(1);

      // 4. 全局搜索
      const search = await (await import("@/repositories/search-repository")).getSearchResults(RUN_TAG);
      expect(search.errands.map((item) => item.id)).not.toContain(expired.id);
      expect(search.errands.map((item) => item.id)).toContain(control.id);

      // 5. sitemap（公开 metadata 面）
      const sitemap = await (await import("@/repositories/sitemap-repository")).getSitemapListings();
      expect(sitemap.errands.map((item) => item.id)).not.toContain(expired.id);

      // 6. favorite 投影 + new favorite 资格（§21/§22：visibility != existence）
      const favoriteRow = await rawClient!.errandFavorite.create({
        data: { userId: viewer.id, errandTaskId: expired.id },
      });
      favoriteIds.push(favoriteRow.id);
      const { getMyErrandFavorites, toggleErrandFavorite } = await import("@/actions/errand-favorite");
      const favorites = await getMyErrandFavorites(viewer.id);
      expect(favorites.map((favorite) => favorite.errandTaskId)).not.toContain(expired.id);
      // favorite 行仍存在（visibility != existence）
      const favoriteExists = await rawClient!.errandFavorite.findUnique({
        where: { userId_errandTaskId: { userId: viewer.id, errandTaskId: expired.id } },
      });
      expect(favoriteExists).not.toBeNull();
      // new favorite 对过期任务 DENY（用另一条未收藏的过期任务：
      // 既有收藏的移除属 allowed wind-down，不受限）
      const expiredAlt = await createErrandFixture({
        publisherId: publisher.id,
        title: `9C02过期收藏资格-${RUN_TAG}`,
        deadlineOffsetMs: -60_000,
      });
      const deny = await toggleErrandFavorite(expiredAlt.id);
      expect(deny.success).toBe(false);
      const denyCreated = await rawClient!.errandFavorite.findUnique({
        where: { userId_errandTaskId: { userId: viewer.id, errandTaskId: expiredAlt.id } },
      });
      expect(denyCreated).toBeNull();

      // 7. owner 管理/历史面保留（§22：owner management/history 仍可见）
      const mine = await (await import("@/repositories/errand-repository")).getMyPublishedErrands(publisher.id);
      expect(mine.map((item) => item.id)).toContain(expired.id);

      // 8. 陌生人公开详情 gate（§22 anti-oracle：页面级组合判定——
      //    status-only 角色为 PUBLIC，deadline 维度 SSOT 谓词必须否决）
      const { resolveListingLifecycleAccess } = await import("@/lib/listings/listing-visibility");
      const { isErrandPubliclyExposed } = await import("@/lib/listings/listing-lifecycle");
      const strangerRole = resolveListingLifecycleAccess({
        status: expired.status,
        viewerId: null,
        ownerId: publisher.id,
        isParticipant: false,
      });
      expect(strangerRole).toBe("PUBLIC");
      expect(isErrandPubliclyExposed(expired.status, expired.deadline, new Date())).toBe(false);

      // 对照：未来 deadline 的 OPEN 任务在全部公开面可见
      const controlDetail = await getErrandDetail(expired.id);
      expect(controlDetail.relatedErrands.map((item) => item.id)).toContain(control.id);

      sessionSeam.actionUser.current = null;
    });

    it("ERRAND-DEADLINE-CLAIM-01（§4 红线）：过期 OPEN 任务 production claimErrandTx → DENY，零 Task/Order/Notification；worker 未执行前 Task 仍 OPEN", async () => {
      const { claimErrandTx } = await import("@/lib/order-creation");
      const { withTransaction } = await import("@/lib/prisma");

      const publisher = await createFixtureUser("CLAIM过期发布者");
      const claimer = await createFixtureUser("CLAIM过期接单者");

      const expired = await createErrandFixture({
        publisherId: publisher.id,
        title: `过期可接任务-${RUN_TAG}`,
        deadlineOffsetMs: -60_000,
      });

      const denied = await withTransaction((tx: Prisma.TransactionClient) =>
        claimErrandTx(tx, {
          errandId: expired.id,
          publisherId: publisher.id,
          claimerId: claimer.id,
          campusId,
          reward: expired.reward,
        }),
      );

      expect(denied).toBeNull();

      // worker 未执行前：Task 保持原状（materialization 是 scheduler 职责，
      // 不是 claim 的副作用）；义务/通知零产生
      const task = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: expired.id } });
      expect(task.status).toBe("OPEN");
      expect(task.accepterId).toBeNull();

      const orderCount = await rawClient!.order.count({
        where: { type: "ERRAND", errandTaskId: expired.id },
      });
      expect(orderCount).toBe(0);

      const notificationCount = await rawClient!.notification.count({
        where: { userId: { in: [publisher.id, claimer.id] } },
      });
      expect(notificationCount).toBe(0);

      // 边界（INV-02/§2.1 严格大于）：deadline == now 属过期 → DENY
      const boundary = await createErrandFixture({
        publisherId: publisher.id,
        title: `边界任务-${RUN_TAG}`,
        deadlineOffsetMs: 30_000,
      });
      const exactDeadline = await rawClient!
        .errandTask.findUniqueOrThrow({ where: { id: boundary.id } })
        .then((row) => row.deadline);
      const boundaryDenied = await withTransaction((tx: Prisma.TransactionClient) =>
        claimErrandTx(
          tx,
          {
            errandId: boundary.id,
            publisherId: publisher.id,
            claimerId: claimer.id,
            campusId,
            reward: boundary.reward,
          },
          undefined,
          undefined,
          { now: exactDeadline },
        ),
      );
      expect(boundaryDenied).toBeNull();

      // 阳性对照：未来 deadline 的同构任务 claim 正常成功（证明 DENY 由
      // deadline 单独因果，非 fixture/治理噪音）
      const future = await createErrandFixture({
        publisherId: publisher.id,
        title: `未来可接任务-${RUN_TAG}`,
        deadlineOffsetMs: 60 * 60 * 1000,
      });
      const claimed = await withTransaction((tx: Prisma.TransactionClient) =>
        claimErrandTx(tx, {
          errandId: future.id,
          publisherId: publisher.id,
          claimerId: claimer.id,
          campusId,
          reward: future.reward,
        }),
      );
      expect(claimed).not.toBeNull();
      if (claimed) {
        orderIds.push(claimed.id);
      }
      const claimedTask = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: future.id } });
      expect(claimedTask.status).toBe("CLAIMED");
      expect(claimedTask.accepterId).toBe(claimer.id);
    });

    it("ERRAND-DEADLINE-HOMEPAGE-CACHE-01（RB01）：warm cache → 仅 deadline 跨界（TTL 未过期、无 worker/无失效）→ 首页两榜与 errandCount 立即 fail closed", async () => {
      // 专用 campus：隔离 homepage cache key（cachedPublicRead 以 campusId 为 key）
      const dedicatedCampus = await rawClient!.campus.create({
        data: {
          name: `9C02 cache 校区 ${randomUUID().slice(0, 6)}`,
          slug: `p9c02-cache-${randomUUID().slice(0, 8)}`,
          schoolName: "集成测试大学",
        },
      });
      dedicatedCampusIds.push(dedicatedCampus.id);
      const publisher = await createFixtureUser("CACHE发布者");
      await rawClient!.campusMembership.updateMany({
        where: { userId: publisher.id },
        data: { campusId: dedicatedCampus.id },
      });
      await rawClient!.user.update({
        where: { id: publisher.id },
        data: { campusId: dedicatedCampus.id },
      });

      const errand = await createErrandFixture({
        publisherId: publisher.id,
        title: `9C02cache任务-${RUN_TAG}`,
        deadlineOffsetMs: 60 * 60 * 1000,
        campusIdOverride: dedicatedCampus.id,
      });

      const home = await import("@/repositories/home-repository");

      // 1. warm cache（旧实现把两榜与 errandCount 一并写入 30s TTL entry）
      const warmSections = await home.getHomepageErrands({ campusId: dedicatedCampus.id });
      expect(
        [...warmSections.urgentErrands, ...warmSections.highRewardErrands].map((item) => item.id),
      ).toContain(errand.id);
      const warmSummary = await home.getHomepageSummary({ campusId: dedicatedCampus.id });
      expect(warmSummary.errandCount).toBe(1);

      // 2. 仅推进 deadline 到过去：不改 status、不清 cache、不跑 scheduler/worker
      await rawClient!.errandTask.update({
        where: { id: errand.id },
        data: { deadline: new Date(Date.now() - 1000) },
      });

      // 3. TTL（30s）远未过期时立即复读：deadline 已跨界 ⇒ 必须立即不可见
      const sections = await home.getHomepageErrands({ campusId: dedicatedCampus.id });
      expect(sections.urgentErrands.map((item) => item.id)).not.toContain(errand.id);
      expect(sections.highRewardErrands.map((item) => item.id)).not.toContain(errand.id);
      const summary = await home.getHomepageSummary({ campusId: dedicatedCampus.id });
      expect(summary.errandCount).toBe(0);
    });

    it("ERRAND-DEADLINE-EDIT-01（§5.1）：current deadline 已过 → DEADLINE_EXPIRED 零写，不得延长复活；未来 deadline 编辑照常", async () => {
      const { updateErrandContentTx } = await import("@/lib/errand-lifecycle");
      const { withTransaction } = await import("@/lib/prisma");

      const publisher = await createFixtureUser("EDIT过期发布者");

      const expired = await createErrandFixture({
        publisherId: publisher.id,
        title: `过期待编辑-${RUN_TAG}`,
        deadlineOffsetMs: -60_000,
      });

      const content = {
        title: `过期任务改标题-${RUN_TAG}`,
        description: "尝试把过期任务延长到未来（revival 尝试）。",
        categoryId: errandCategoryId,
        reward: new Prisma.Decimal("12.00"),
        pickupLocation: "东门",
        deliveryLocation: "西门",
        deadline: new Date(Date.now() + 60 * 60 * 1000),
        contactNote: null,
        needsAdvancePay: false,
        advanceAmount: null,
      };

      const outcome = await withTransaction((tx: Prisma.TransactionClient) =>
        updateErrandContentTx(tx, publisher.id, expired.id, content),
      );

      expect(outcome).toBe("DEADLINE_EXPIRED");

      // 零 mutation：行保持原 deadline / 原 title（row 未被 materialize 也不得复活）
      const row = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: expired.id } });
      expect(row.title).toBe(`过期待编辑-${RUN_TAG}`);
      expect(row.deadline.getTime()).toBeLessThan(Date.now());
      expect(row.status).toBe("OPEN");

      // 阳性对照：未来 deadline 的 OPEN 任务编辑正常（deadline 可顺延）
      const future = await createErrandFixture({
        publisherId: publisher.id,
        title: `未来待编辑-${RUN_TAG}`,
        deadlineOffsetMs: 60 * 60 * 1000,
      });
      const updated = await withTransaction((tx: Prisma.TransactionClient) =>
        updateErrandContentTx(tx, publisher.id, future.id, content),
      );
      expect(updated).toBe("UPDATED");
      const updatedRow = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: future.id } });
      expect(updatedRow.title).toBe(content.title);
      expect(updatedRow.deadline.getTime()).toBe(content.deadline.getTime());
    });

    it("ERRAND-DEADLINE-REOPEN-01（§5.2）：过期 CLAIMED + active ACCEPTED Order → reopen DENY，Task/Order pair 原样", async () => {
      const { transitionErrandTx } = await import("@/lib/errand-lifecycle");
      const { withTransaction } = await import("@/lib/prisma");

      const publisher = await createFixtureUser("REOPEN发布者");
      const accepter = await createFixtureUser("REOPEN接单者");

      const claimed = await createErrandFixture({
        publisherId: publisher.id,
        title: `过期已接单-${RUN_TAG}`,
        status: "CLAIMED",
        accepterId: accepter.id,
        deadlineOffsetMs: -60_000,
      });
      const order = await createErrandOrderFixture({
        publisherId: publisher.id,
        accepterId: accepter.id,
        errandTaskId: claimed.id,
      });

      const reopened = await withTransaction((tx: Prisma.TransactionClient) =>
        transitionErrandTx(tx, publisher.id, claimed.id, "OPEN"),
      );

      expect(reopened).toBe(false);

      // canonical pair 原样：Task CLAIMED + Order ACCEPTED（deadline 不自动
      // 取消既有履约义务，§2.1；仅拒绝重新暴露）
      const task = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: claimed.id } });
      expect(task.status).toBe("CLAIMED");
      expect(task.accepterId).toBe(accepter.id);
      const persistedOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(persistedOrder.status).toBe("ACCEPTED");

      const notificationCount = await rawClient!.notification.count({
        where: { userId: { in: [publisher.id, accepter.id] } },
      });
      expect(notificationCount).toBe(0);
    });
  },
);
