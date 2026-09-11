import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Phase 6C-2 Appeal HTTP Entry 集成测试（真实 PostgreSQL）。
 *
 * 覆盖（Planning Repair 1/2 + Implementation §22–§24 冻结矩阵）：
 *  - HTTP：submit（SUSPENDED/ACTIVE、anti-enumeration、duplicate、strict body）、
 *    withdraw（SUBMITTED/IN_REVIEW）、stale erased session
 *  - DISCOVERY：51 条全量遍历（同 createdAt tie-break）、ownership 隔离、
 *    cursor 400 / forged-valid-cursor 不可越权、末页 null、6 种 Appeal 状态
 *  - 身份：UNAUTHENTICATED / ACCOUNT_INELIGIBLE 单一不透明 401
 *
 * 身份注入：仅 mock @/lib/auth 的 auth()（session 抽取点）；resolver 的
 * DB 复查、路由合同、domain 语义、真实 PG 全部为真。并发/限流不引入
 * sleep——submit/list 桶用 resetRateLimit 确定性清零。
 *
 * 本文件不写合成 enforcementSeq（全部走 DB sequence 真实分配），与并行
 * 集成文件的合成值段天然不相交。
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p6c2-${randomUUID().slice(0, 8)}`;
const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdActionIds: string[] = [];
const createdAppealIds: string[] = [];

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));

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
  options: { status?: "ACTIVE" | "SUSPENDED" } = {},
) {
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${createdUserIds.length}@it.local`,
      name,
      passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
      schoolName: "集成测试大学",
      campusId,
      role: "STUDENT",
      status: options.status ?? "ACTIVE",
    },
  });
  createdUserIds.push(user.id);
  await rawClient!.campusMembership.create({
    data: { userId: user.id, campusId, status: "ACTIVE" },
  });
  return user;
}

async function createPunitiveAction(input: {
  targetId: string;
  actorId: string;
  type: "ACCOUNT_SUSPEND" | "MEMBERSHIP_SUSPEND" | "MARKETPLACE_RESTRICT";
  createdAt?: Date;
  campusId?: string | null;
}) {
  const campusId = input.campusId ?? null;
  const action = await rawClient!.enforcementAction.create({
    data: {
      type: input.type,
      actorId: input.actorId,
      targetId: input.targetId,
      campusId,
      scopeKey: campusId ? `CAMPUS:${campusId}` : "GLOBAL",
      reasonCode: "MANUAL_REVIEW",
      resultState:
        input.type === "ACCOUNT_SUSPEND"
          ? "USER:SUSPENDED"
          : input.type === "MEMBERSHIP_SUSPEND"
            ? "CAMPUS_MEMBERSHIP:SUSPENDED"
            : "RISK_STATE:RESTRICTED",
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
  createdActionIds.push(action.id);
  return action;
}

function sessionOf(userId: string | null) {
  mockAuth.mockResolvedValue(userId ? { user: { id: userId } } : null);
}

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 6C-2 Appeal HTTP entry（真实 PostgreSQL）",
  () => {
    let campus: { id: string };
    let suspendedUser: { id: string };
    let activeUser: { id: string };
    let outsider: { id: string };
    let admin: { id: string };

    beforeAll(async () => {
      campus = await createFixtureCampus("httpentry");
      suspendedUser = await createFixtureUser("停用申诉人", campus.id, { status: "SUSPENDED" });
      activeUser = await createFixtureUser("活跃申诉人", campus.id);
      outsider = await createFixtureUser("局外人", campus.id);
      admin = await createFixtureUser("执法actor", campus.id);
    });

    afterAll(async () => {
      if (!rawClient) return;
      await rawClient.appeal.deleteMany({ where: { enforcementActionId: { in: createdActionIds } } });
      await rawClient.enforcementAction.deleteMany({ where: { id: { in: createdActionIds } } });
      await rawClient.campusMembership.deleteMany({ where: { userId: { in: createdUserIds } } });
      await rawClient.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
      await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
      await rawClient.campus.deleteMany({ where: { id: { in: createdCampusIds } } });
      await rawClient.$disconnect();
    });

    it("HTTP-1: unauthenticated submit → 401 UNAUTHENTICATED", async () => {
      const { POST } = await import("@/app/api/appeals/route");
      sessionOf(null);

      const response = await POST(
        new Request("http://localhost/api/appeals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enforcementActionId: "whatever", statement: "x" }),
        }) as never,
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "未登录或账号不可用",
        code: "UNAUTHENTICATED",
      });
    });

    it("HTTP-2: SUSPENDED appellant submits against own ACCOUNT_SUSPEND → 201", async () => {
      const [{ POST }, { resetRateLimit }] = await Promise.all([
        import("@/app/api/appeals/route"),
        import("@/lib/rate-limit"),
      ]);
      const action = await createPunitiveAction({
        targetId: suspendedUser.id,
        actorId: admin.id,
        type: "ACCOUNT_SUSPEND",
      });
      sessionOf(suspendedUser.id);
      await resetRateLimit(`appeal:submit:${suspendedUser.id}`);

      const response = await POST(
        new Request("http://localhost/api/appeals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enforcementActionId: action.id,
            statement: "我的账号被误封，请复核",
          }),
        }) as never,
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.appeal.status).toBe("SUBMITTED");
      expect(body.appeal.statement).toBe("我的账号被误封，请复核");
      expect(response.headers.get("cache-control")).toBe("private, no-store");

      const inDb = await rawClient!.appeal.findUnique({ where: { id: body.appeal.id } });
      expect(inDb?.status).toBe("SUBMITTED");
      createdAppealIds.push(body.appeal.id);
    });

    it("HTTP-3/3B: ACTIVE appellant submits against MEMBERSHIP_SUSPEND and MARKETPLACE_RESTRICT → 201", async () => {
      const [{ POST }, { resetRateLimit }] = await Promise.all([
        import("@/app/api/appeals/route"),
        import("@/lib/rate-limit"),
      ]);
      const membership = await createPunitiveAction({
        targetId: activeUser.id,
        actorId: admin.id,
        type: "MEMBERSHIP_SUSPEND",
        campusId: campus.id,
      });
      const risk = await createPunitiveAction({
        targetId: activeUser.id,
        actorId: admin.id,
        type: "MARKETPLACE_RESTRICT",
      });
      sessionOf(activeUser.id);
      await resetRateLimit(`appeal:submit:${activeUser.id}`);

      for (const action of [membership, risk]) {
        const response = await POST(
          new Request("http://localhost/api/appeals", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enforcementActionId: action.id, statement: "申诉" }),
          }) as never,
        );
        expect(response.status).toBe(201);
        const body = await response.json();
        createdAppealIds.push(body.appeal.id);
      }
    });

    it("HTTP-4: client-supplied identity fields → strict 400", async () => {
      const { POST } = await import("@/app/api/appeals/route");
      const action = await createPunitiveAction({
        targetId: outsider.id,
        actorId: admin.id,
        type: "ACCOUNT_SUSPEND",
      });
      sessionOf(outsider.id);

      const response = await POST(
        new Request("http://localhost/api/appeals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enforcementActionId: action.id,
            statement: "x",
            callerUserId: suspendedUser.id,
            targetUserId: suspendedUser.id,
          }),
        }) as never,
      );

      expect(response.status).toBe(400);
      const inDb = await rawClient!.appeal.findUnique({
        where: { enforcementActionId: action.id },
      });
      expect(inDb).toBeNull();
    });

    it("HTTP-5: another user's enforcementActionId → unified 404 anti-enumeration", async () => {
      const { POST } = await import("@/app/api/appeals/route");
      const theirs = await createPunitiveAction({
        targetId: suspendedUser.id,
        actorId: admin.id,
        type: "ACCOUNT_SUSPEND",
      });
      sessionOf(outsider.id);

      const response = await POST(
        new Request("http://localhost/api/appeals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enforcementActionId: theirs.id, statement: "x" }),
        }) as never,
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "申诉不存在" });
    });

    it("HTTP-6: erased stale session → opaque 401 on submit", async () => {
      const { POST } = await import("@/app/api/appeals/route");
      const erased = await createFixtureUser("已注销人", campus.id);
      await rawClient!.user.update({
        where: { id: erased.id },
        data: { erasedAt: new Date() },
      });
      sessionOf(erased.id);

      const response = await POST(
        new Request("http://localhost/api/appeals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enforcementActionId: "whatever", statement: "x" }),
        }) as never,
      );

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.code).toBe("ACCOUNT_INELIGIBLE");
      expect(JSON.stringify(body)).not.toContain("ERASED");
    });

    it("HTTP-7: duplicate appeal → 409", async () => {
      const { POST } = await import("@/app/api/appeals/route");
      const action = await rawClient!.enforcementAction.findFirstOrThrow({
        where: { targetId: suspendedUser.id, type: "ACCOUNT_SUSPEND" },
      });
      sessionOf(suspendedUser.id);
      const { resetRateLimit } = await import("@/lib/rate-limit");
      await resetRateLimit(`appeal:submit:${suspendedUser.id}`);

      const response = await POST(
        new Request("http://localhost/api/appeals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enforcementActionId: action.id, statement: "再次申诉" }),
        }) as never,
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "该执法记录已提交过申诉，不能重复提交",
      });
    });

    it("HTTP-10: appellant responses never contain decisionNote/reviewedById", async () => {
      const { POST } = await import("@/app/api/appeals/route");
      sessionOf(suspendedUser.id);
      const { resetRateLimit } = await import("@/lib/rate-limit");
      await resetRateLimit(`appeal:submit:${suspendedUser.id}`);

      const action = await rawClient!.enforcementAction.findFirstOrThrow({
        where: { targetId: suspendedUser.id, type: "ACCOUNT_SUSPEND" },
      });
      const response = await POST(
        new Request("http://localhost/api/appeals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enforcementActionId: action.id, statement: "x" }),
        }) as never,
      );
      // duplicate → 409 路径同样只含安全文案
      expect([201, 409]).toContain(response.status);
      const raw = JSON.stringify(await response.json());
      for (const forbidden of ["decisionNote", "reviewedById"]) {
        expect(raw).not.toContain(forbidden);
      }
    });

    it("HTTP-8: withdraw own SUBMITTED appeal → 200 WITHDRAWN", async () => {
      const { POST } = await import("@/app/api/appeals/route");
      const { resetRateLimit } = await import("@/lib/rate-limit");
      const action = await createPunitiveAction({
        targetId: activeUser.id,
        actorId: admin.id,
        type: "ACCOUNT_SUSPEND",
      });
      sessionOf(activeUser.id);
      await resetRateLimit(`appeal:submit:${activeUser.id}`);

      const submit = await POST(
        new Request("http://localhost/api/appeals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enforcementActionId: action.id, statement: "待撤回" }),
        }) as never,
      );
      expect(submit.status).toBe(201);
      const { appeal } = await submit.json();
      createdAppealIds.push(appeal.id);

      const { POST: withdrawPost } = await import("@/app/api/appeals/[id]/withdraw/route");
      await resetRateLimit(`appeal:withdraw:${activeUser.id}`);
      const withdrawn = await withdrawPost(
        new Request(`http://localhost/api/appeals/${appeal.id}/withdraw`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }) as never,
        { params: Promise.resolve({ id: appeal.id }) } as never,
      );

      expect(withdrawn.status).toBe(200);
      const body = await withdrawn.json();
      expect(body.appeal.status).toBe("WITHDRAWN");
      const inDb = await rawClient!.appeal.findUnique({ where: { id: appeal.id } });
      expect(inDb?.status).toBe("WITHDRAWN");
      expect(inDb?.decisionNote).toBeNull();
      expect(inDb?.reviewedById).toBeNull();
    });

    it("HTTP-9: withdraw IN_REVIEW → 409", async () => {
      const { POST } = await import("@/app/api/appeals/route");
      const { POST: withdrawPost } = await import("@/app/api/appeals/[id]/withdraw/route");
      const { resetRateLimit } = await import("@/lib/rate-limit");
      const action = await createPunitiveAction({
        targetId: outsider.id,
        actorId: admin.id,
        type: "ACCOUNT_SUSPEND",
      });
      sessionOf(outsider.id);
      await resetRateLimit(`appeal:submit:${outsider.id}`);

      const submit = await POST(
        new Request("http://localhost/api/appeals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enforcementActionId: action.id, statement: "审核中" }),
        }) as never,
      );
      const { appeal } = await submit.json();
      createdAppealIds.push(appeal.id);
      await rawClient!.appeal.update({
        where: { id: appeal.id },
        data: { status: "IN_REVIEW" },
      });

      await resetRateLimit(`appeal:withdraw:${outsider.id}`);
      const withdrawn = await withdrawPost(
        new Request(`http://localhost/api/appeals/${appeal.id}/withdraw`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }) as never,
        { params: Promise.resolve({ id: appeal.id }) } as never,
      );

      expect(withdrawn.status).toBe(409);
      const still = await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
      expect(still.status).toBe("IN_REVIEW");
    });

    it("DISCOVERY-1/2/3/4/6/8: 51 punitive actions（同一 createdAt）经分页恰好遍历一次，他人行永不出现", async () => {
      const { GET } = await import("@/app/api/appeals/eligible-actions/route");
      const { resetRateLimit } = await import("@/lib/rate-limit");
      const user = await createFixtureUser("分页用户", campus.id);
      const sameInstant = new Date("2026-02-02T08:00:00.000Z");

      for (let i = 0; i < 51; i += 1) {
        await createPunitiveAction({
          targetId: user.id,
          actorId: admin.id,
          type: i % 3 === 0 ? "ACCOUNT_SUSPEND" : i % 3 === 1 ? "MEMBERSHIP_SUSPEND" : "MARKETPLACE_RESTRICT",
          createdAt: sameInstant,
          campusId: i % 3 === 1 ? campus.id : null,
        });
      }
      // 他人处罚：绝不允许出现在任何页
      await createPunitiveAction({
        targetId: outsider.id,
        actorId: admin.id,
        type: "ACCOUNT_SUSPEND",
        createdAt: sameInstant,
      });

      sessionOf(user.id);
      await resetRateLimit(`appeal:list:${user.id}`);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      for (;;) {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        const response = await GET(new Request(`http://localhost/api/appeals/eligible-actions${query}`) as never);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.items.length).toBeLessThanOrEqual(50);
        seen.push(...body.items.map((item: { enforcementActionId: string }) => item.enforcementActionId));
        pages += 1;
        if (body.nextCursor === null) break;
        cursor = body.nextCursor;
        await resetRateLimit(`appeal:list:${user.id}`);
      }

      expect(pages).toBe(3); // 25 + 25 + 1
      expect(new Set(seen).size).toBe(seen.length); // 无重复
      const owned = await rawClient!.enforcementAction.findMany({
        where: { targetId: user.id, type: { in: ["ACCOUNT_SUSPEND", "MEMBERSHIP_SUSPEND", "MARKETPLACE_RESTRICT"] } },
        select: { id: true },
      });
      expect(seen.sort()).toEqual(owned.map((o: { id: string }) => o.id).sort()); // 无遗漏
      expect(seen).not.toContain(
        (await rawClient!.enforcementAction.findFirstOrThrow({ where: { targetId: outsider.id } })).id,
      );
    }, 120_000);

    it("DISCOVERY-5A/5B: malformed cursor → 400；forged valid cursor 不可越权、末页 null", async () => {
      const { GET } = await import("@/app/api/appeals/eligible-actions/route");
      sessionOf(suspendedUser.id);

      const malformed = await GET(
        new Request("http://localhost/api/appeals/eligible-actions?cursor=%25%25%25") as never,
      );
      expect(malformed.status).toBe(400);

      const forged = Buffer.from(
        JSON.stringify({ createdAt: "2000-01-01T00:00:00.000Z", id: "foreign-ea" }),
      ).toString("base64url");
      const forgedResponse = await GET(
        new Request(`http://localhost/api/appeals/eligible-actions?cursor=${encodeURIComponent(forged)}`) as never,
      );
      expect(forgedResponse.status).toBe(200);
      const body = await forgedResponse.json();
      for (const item of body.items) {
        const row = await rawClient!.enforcementAction.findUniqueOrThrow({
          where: { id: item.enforcementActionId },
          select: { targetId: true },
        });
        expect(row.targetId).toBe(suspendedUser.id);
      }
    });

    it("DISCOVERY-7: all 6 appeal states remain discoverable with {id,status}", async () => {
      const { GET } = await import("@/app/api/appeals/eligible-actions/route");
      const user = await createFixtureUser("状态用户", campus.id);
      const statuses = ["SUBMITTED", "IN_REVIEW", "GRANTED", "UPHELD", "DISMISSED", "WITHDRAWN"] as const;

      for (const status of statuses) {
        const action = await createPunitiveAction({
          targetId: user.id,
          actorId: admin.id,
          type: "MARKETPLACE_RESTRICT",
        });
        const appeal = await rawClient!.appeal.create({
          data: { enforcementActionId: action.id, status, statement: "x" },
        });
        createdAppealIds.push(appeal.id);
      }

      sessionOf(user.id);
      const response = await GET(new Request("http://localhost/api/appeals/eligible-actions") as never);
      expect(response.status).toBe(200);
      const body = await response.json();

      const byStatus = new Map<string, { id: string; status: string } | null>();
      for (const item of body.items) {
        if (item.appeal) byStatus.set(item.appeal.status, item.appeal);
      }
      for (const status of statuses) {
        expect(byStatus.get(status), `status ${status} 必须可发现`).toBeTruthy();
      }
    });

    it("DISCOVERY-9: a SUSPENDED re-authenticated user paginates their own actions (AUTH-3G)", async () => {
      const { GET } = await import("@/app/api/appeals/eligible-actions/route");
      sessionOf(suspendedUser.id);

      const response = await GET(new Request("http://localhost/api/appeals/eligible-actions") as never);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body.items)).toBe(true);
      for (const item of body.items) {
        const row = await rawClient!.enforcementAction.findUniqueOrThrow({
          where: { id: item.enforcementActionId },
          select: { targetId: true },
        });
        expect(row.targetId).toBe(suspendedUser.id);
      }
    });
  },
);
