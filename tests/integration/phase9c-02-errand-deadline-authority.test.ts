import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { GOVERNANCE_LOCK_NAMESPACE } from "./helpers/lock-barrier";
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


/**
 * RB02 race fixtures：T1 持锁专用连接（application_name 精确标识）+
 * pg_blocking_pids barrier——证明 T2 已真实进入 T1 所持锁的等待队列
 * （零 sleep；不依赖 advisory lock 专属 helper，行锁等待同样覆盖）。
 */
const T1_APP_NAME = `p9c02-r1-t1-${RUN_TAG}`;

function createT1Client() {
  const baseUrl = process.env.DATABASE_URL ?? integrationDatabaseUrl ?? "";
  const separator = baseUrl.includes("?") ? "&" : "?";
  return new PrismaClient({
    datasources: { db: { url: `${baseUrl}${separator}application_name=${T1_APP_NAME}` } },
    log: ["error"],
  });
}

async function waitForBlockerBarrier(client: PrismaClient, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await client.$queryRaw<{ blocked: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity a
        WHERE cardinality(pg_blocking_pids(a.pid)) > 0
          AND EXISTS (
            SELECT 1
            FROM unnest(pg_blocking_pids(a.pid)) AS blocker_pid
            JOIN pg_stat_activity b ON b.pid = blocker_pid
            WHERE b.application_name = ${T1_APP_NAME}
          )
      ) AS blocked
    `;
    if (rows[0]?.blocked) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("RB02 barrier 超时：T2 未进入 T1 所持锁的等待队列");
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

    it("ERRAND-DEADLINE-EDIT-RACE-01（RB02/§14）：edit 在 USER 锁上等待期间真实时间跨越 deadline → authority 后判定 DEADLINE_EXPIRED 零写（请求开始 ≠ 获得 authority）", async () => {
      const { updateErrandContentTx } = await import("@/lib/errand-lifecycle");
      const { withTransaction } = await import("@/lib/prisma");

      const publisher = await createFixtureUser("RACEEDIT发布者");
      const errand = await createErrandFixture({
        publisherId: publisher.id,
        title: `RB02编辑竞速-${RUN_TAG}`,
        deadlineOffsetMs: 60 * 60 * 1000,
      });
      const t1Client = createT1Client();

      // T1：真实持有 USER:publisher governance lock，保持不提交
      let signalT1Locked!: () => void;
      const t1Locked = new Promise<void>((resolve) => {
        signalT1Locked = resolve;
      });
      let releaseT1!: () => void;
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });
      const t1Promise = t1Client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${GOVERNANCE_LOCK_NAMESPACE}::int, hashtext(${`USER:${publisher.id}`}))`;
        signalT1Locked();
        await t1Gate;
        return true;
      }, { timeout: 60_000 });
      await t1Locked;

      // T2：生产 updateErrandContentTx（生产路径不传时钟 seam）——被 T1 阻塞
      const content = {
        title: `RB02复活尝试-${RUN_TAG}`,
        description: "锁等待期间 deadline 已真实跨界，仍尝试延长复活。",
        categoryId: errandCategoryId,
        reward: errand.reward,
        pickupLocation: "东门",
        deliveryLocation: "西门",
        deadline: new Date(Date.now() + 60 * 60 * 1000),
        contactNote: null,
        needsAdvancePay: false,
        advanceAmount: null,
      };
      const t2Promise = withTransaction((tx: Prisma.TransactionClient) =>
        updateErrandContentTx(tx, publisher.id, errand.id, content),
      );

      // 真实锁等待证据：T2 已进入 T1 所持锁的等待队列（pg_blocking_pids）
      await waitForBlockerBarrier(t1Client);

      // barrier 之后取时间戳 D：请求开始时刻（T2 若在锁前捕获 now，必小于 D）。
      // release 后的任何 authority 时刻 >= D（时钟单调），因此：
      //   旧实现（锁前捕获 now）→ now0 < D = deadline → 复活成功（旧 HEAD 上本测试失败）
      //   新实现（row authority 后捕获 now）→ now >= D → DEADLINE_EXPIRED
      const decisionBoundary = new Date();
      await rawClient!.errandTask.update({
        where: { id: errand.id },
        data: { deadline: decisionBoundary },
      });

      releaseT1();
      const [t1Settled, t2Settled] = await Promise.allSettled([t1Promise, t2Promise]);
      expect(t1Settled.status).toBe("fulfilled");
      expect(t2Settled.status).toBe("fulfilled");
      if (t2Settled.status === "fulfilled") {
        expect(t2Settled.value).toBe("DEADLINE_EXPIRED");
      }

      // zero revival：行保持 deadline 已过期态 + 原内容 + OPEN
      const row = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } });
      expect(row.title).toBe(`RB02编辑竞速-${RUN_TAG}`);
      expect(row.deadline.getTime()).toBe(decisionBoundary.getTime());
      expect(row.deadline.getTime()).toBeLessThanOrEqual(Date.now());
      expect(row.status).toBe("OPEN");
      expect(row.accepterId).toBeNull();

      await t1Client.$disconnect();
    });

    it("ERRAND-DEADLINE-CLAIM-LOCK-CLOCK-01（RB02/§15）：claim 在行锁上等待期间 deadline 跨界（T1 事务内推进）→ row authority 后判定 DENY 零义务", async () => {
      const { claimErrandTx } = await import("@/lib/order-creation");
      const { withTransaction } = await import("@/lib/prisma");

      const publisher = await createFixtureUser("RACECLAIM发布者");
      const claimer = await createFixtureUser("RACECLAIM接单者");
      const errand = await createErrandFixture({
        publisherId: publisher.id,
        title: `RB02接单竞速-${RUN_TAG}`,
        deadlineOffsetMs: 60 * 60 * 1000,
      });
      const t1Client = createT1Client();

      // T1：真实持有 ErrandTask 行锁（FOR UPDATE），保持不提交
      let signalT1Locked!: () => void;
      const t1Locked = new Promise<void>((resolve) => {
        signalT1Locked = resolve;
      });
      let releaseT1!: () => void;
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });
      // 行锁被 T1 持有时外部无法 UPDATE 该行——deadline 跨界由 T1 在自身
      // 事务内推进（barrier 确认 T2 等待后，取当下时刻写入并提交）
      const t1Promise = t1Client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM "ErrandTask" WHERE id = ${errand.id} FOR UPDATE`;
        signalT1Locked();
        await t1Gate;
        await tx.$executeRaw`UPDATE "ErrandTask" SET "deadline" = ${new Date()} WHERE id = ${errand.id}`;
        return true;
      }, { timeout: 60_000 });
      await t1Locked;

      // T2：生产 claimErrandTx（生产路径不传时钟 seam）——行权威前被 T1 阻塞
      const t2Promise = withTransaction((tx: Prisma.TransactionClient) =>
        claimErrandTx(tx, {
          errandId: errand.id,
          publisherId: publisher.id,
          claimerId: claimer.id,
          campusId,
          reward: errand.reward,
        }),
      );

      // 真实锁等待证据：T2 已进入 T1 行锁的等待队列
      await waitForBlockerBarrier(t1Client);

      releaseT1();
      const [t1Settled, t2Settled] = await Promise.allSettled([t1Promise, t2Promise]);
      expect(t1Settled.status).toBe("fulfilled");
      expect(t2Settled.status).toBe("fulfilled");
      if (t2Settled.status === "fulfilled") {
        expect(t2Settled.value).toBeNull();
      }

      // zero Order / zero Notification / Task 保持 OPEN + 过期 deadline
      const row = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } });
      expect(row.status).toBe("OPEN");
      expect(row.accepterId).toBeNull();
      expect(row.deadline.getTime()).toBeLessThanOrEqual(Date.now());
      expect(
        await rawClient!.order.count({ where: { type: "ERRAND", errandTaskId: errand.id } }),
      ).toBe(0);
      expect(
        await rawClient!.notification.count({ where: { userId: { in: [publisher.id, claimer.id] } } }),
      ).toBe(0);

      await t1Client.$disconnect();
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
