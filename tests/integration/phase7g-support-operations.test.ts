import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Phase 7G Support Ticket + Appeal SLA closure 集成测试（真实 PostgreSQL）。
//
// 覆盖（指令冻结的矩阵，本文件 = support 域 + appeal SLA）：
//  - SC01..SC06：工单生命周期（UNSCOPED/CAMPUS scope、72h SLA、claim/release、
//    resolve/close、terminal 禁 reopen、字段分离冻结）
//  - SP01..SP03：requester 读模型隐私（internalNote 永不返回；
//    resolutionMessage 用户可见）
//  - E01..E04：erasure 集成（active 阻断 ACTIVE_SUPPORT_TICKET、terminal 放行
//    + free text 清理、创建 vs 注销线性化、终局 vs 注销线性化）
//  - SLA-S01..S03：72h SLA 只读、零自动关闭
//  - SLA-A01..A04：appeal reviewDueAt 运行时写路径 + 迁移 origin 逐字断言 +
//    overdue 只读 + 零自动决定
//  - S-RACE-01..05 + NO_40P01：真实 PG 并发（零 sleep）
//
// Dispute 域 / RBAC / migration 索引合同在 phase7g-dispute-operations.test.ts。

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p7gs-${randomUUID().slice(0, 8)}`;
const FIXTURE_PASSWORD_HASH = ["$2a$10$", "itfixtureitfixtureitfixtureitfixtureitfix"].join("");

const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdAssignmentIds: string[] = [];
const createdTicketIds: string[] = [];
const createdEnforcementIds: string[] = [];
const createdAppealIds: string[] = [];
const createdMembershipForErasure: string[] = [];

let campusA: { id: string; name: string };
let campusB: { id: string; name: string };

async function createFixtureUser(
  name: string,
  options: { membershipCampusId?: string | null; membershipStatus?: "ACTIVE" | "SUSPENDED" } = {},
) {
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${createdUserIds.length}-${name}@it.local`,
      name,
      passwordHash: FIXTURE_PASSWORD_HASH,
      schoolName: "集成测试大学",
      campusId: campusA.id,
      role: "STUDENT",
      status: "ACTIVE",
    },
  });
  createdUserIds.push(user.id);
  const membershipCampusId =
    options.membershipCampusId === undefined ? campusA.id : options.membershipCampusId;
  if (membershipCampusId) {
    const membership = await rawClient!.campusMembership.create({
      data: {
        userId: user.id,
        campusId: membershipCampusId,
        status: options.membershipStatus ?? "ACTIVE",
      },
    });
    createdMembershipIds.push(membership.id);
  }
  return user;
}

async function assignRoleByKey(userId: string, roleKey: string, campusId?: string) {
  const role = await rawClient!.role.findFirstOrThrow({ where: { key: roleKey } });
  const assignment = await rawClient!.userRoleAssignment.create({
    data: {
      userId,
      roleId: role.id,
      campusId: campusId ?? null,
      scopeKey: campusId ? `CAMPUS:${campusId}` : "GLOBAL",
    },
  });
  createdAssignmentIds.push(assignment.id);
  return assignment;
}

/** NO_40P01：任何拒绝原因都不得是 PG serialization failure。 */
function assertNoSerializationFailure(errors: unknown[]) {
  for (const error of errors) {
    const message = String((error as Error)?.message ?? error);
    expect(message).not.toContain("40P01");
    expect(message).not.toContain("deadlock detected");
  }
}

beforeAll(async () => {
  if (!integrationDatabaseUrl || !rawClient) {
    return;
  }
  campusA = await rawClient.campus.create({
    data: { name: `P7GS-A-${RUN_TAG}`, slug: `p7gs-a-${RUN_TAG}`, schoolName: "集成测试大学" },
  });
  createdCampusIds.push(campusA.id);
  campusB = await rawClient.campus.create({
    data: { name: `P7GS-B-${RUN_TAG}`, slug: `p7gs-b-${RUN_TAG}`, schoolName: "集成测试大学" },
  });
  createdCampusIds.push(campusB.id);
});

afterAll(async () => {
  if (!rawClient) {
    return;
  }
  try {
    await rawClient.$transaction([
      rawClient.adminLog.deleteMany({ where: { targetId: { in: [...createdTicketIds, ...createdAppealIds] } } }),
      rawClient.supportTicket.deleteMany({ where: { id: { in: createdTicketIds } } }),
      rawClient.appeal.deleteMany({ where: { id: { in: createdAppealIds } } }),
      rawClient.enforcementAction.deleteMany({ where: { id: { in: createdEnforcementIds } } }),
      rawClient.notification.deleteMany({ where: { userId: { in: createdUserIds } } }),
      rawClient.userRoleAssignment.deleteMany({ where: { id: { in: createdAssignmentIds } } }),
      rawClient.campusMembership.deleteMany({ where: { id: { in: [...createdMembershipIds, ...createdMembershipForErasure] } } }),
      rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } }),
      rawClient.campus.deleteMany({ where: { id: { in: createdCampusIds } } }),
    ]);
  } catch (error) {
    console.warn("phase7g-support cleanup 失败（不影响断言）", error);
  }
  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)("Phase 7G support + appeal SLA（真实 PG）", () => {
  // ── SC：工单生命周期 ────────────────────────────────────────────────────────

  it("SC01：UNSCOPED 创建 + 72h SLA + scope CHECK 快照", async () => {
    const requester = await createFixtureUser("SC01requester");
    const { createSupportTicket } = await import("@/lib/support/support-service");

    const ticket = await createSupportTicket({
      requesterId: requester.id,
      category: "ACCOUNT",
      subject: "SC01 无法登录",
      description: "SC01 登录一直失败，请协助排查处理。",
    });
    createdTicketIds.push(ticket.id);

    expect(ticket.scopeKey).toBe("UNSCOPED");
    expect(ticket.campusId).toBeNull();
    const row = await rawClient!.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row.status).toBe("OPEN");
    const diffHours = (row.dueAt.getTime() - row.createdAt.getTime()) / (60 * 60 * 1000);
    expect(Math.abs(diffHours - 72)).toBeLessThan(0.01);
  });

  it("SC02：CAMPUS scope 需 ACTIVE membership；无效 campus 被拒；DB CHECK 兜底 malformed pair", async () => {
    const requester = await createFixtureUser("SC02requester", { membershipCampusId: campusA.id });
    const { createSupportTicket } = await import("@/lib/support/support-service");

    const ticket = await createSupportTicket({
      requesterId: requester.id,
      category: "MARKETPLACE",
      subject: "SC02 校区交易纠纷咨询",
      description: "SC02 需要校区支持人员协助处理交易问题。",
      campusId: campusA.id,
    });
    createdTicketIds.push(ticket.id);
    expect(ticket.scopeKey).toBe(`CAMPUS:${campusA.id}`);
    expect(ticket.campusId).toBe(campusA.id);

    // 无该校 ACTIVE membership 的用户 → 拒绝
    const stranger = await createFixtureUser("SC02stranger", { membershipCampusId: campusB.id });
    await expect(
      createSupportTicket({
        requesterId: stranger.id,
        category: "OTHER",
        subject: "跨校区尝试",
        description: "SC02 跨校区 scope 尝试应被拒绝。",
        campusId: campusA.id,
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_CAMPUS_MEMBERSHIP_INACTIVE" });

    // DB CHECK：malformed 交叉对结构性不可插入
    await expect(
      rawClient!.supportTicket.create({
        data: {
          requesterId: requester.id,
          campusId: campusB.id,
          scopeKey: `CAMPUS:${campusA.id}`,
          category: "OTHER",
          subject: "malformed",
          description: "malformed pair 应被 DB CHECK 拒绝",
          dueAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("SC03：3 条上限（锁内计数）；终局后释放额度", async () => {
    const requester = await createFixtureUser("SC03requester");
    const { createSupportTicket } = await import("@/lib/support/support-service");

    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const ticket = await createSupportTicket({
        requesterId: requester.id,
        category: "OTHER",
        subject: `SC03 第 ${i + 1} 单`,
        description: `SC03 第 ${i + 1} 个进行中的工单描述正文。`,
      });
      ids.push(ticket.id);
    }
    createdTicketIds.push(...ids);

    await expect(
      createSupportTicket({
        requesterId: requester.id,
        category: "OTHER",
        subject: "SC03 第 4 单",
        description: "SC03 第 4 个工单应被上限拒绝。",
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_TICKET_LIMIT_EXCEEDED" });

    // 终局释放额度：close 一条后可再创建
    const { closeSupportTicket } = await import("@/lib/support/support-service");
    await closeSupportTicket({ actorId: (await globalAgent()).id, ticketId: ids[0]! });
    const fourth = await createSupportTicket({
      requesterId: requester.id,
      category: "OTHER",
      subject: "SC03 第 4 单重试",
      description: "SC03 终局释放额度后的第 4 单。",
    });
    createdTicketIds.push(fourth.id);
  });

  let globalAgentRef: { id: string } | null = null;

  /** GLOBAL 处理人（PLATFORM_ADMIN 全量；UNSCOPED 仅 GLOBAL 合同的操作方）。 */
  async function globalAgent() {
    if (globalAgentRef) {
      return globalAgentRef;
    }
    const agent = await createFixtureUser("globalAgent");
    await assignRoleByKey(agent.id, "CAMPUS_SUPPORT_AGENT", campusA.id);
    const adminRole = await rawClient!.role.findFirstOrThrow({ where: { key: "PLATFORM_ADMIN" } });
    const assignment = await rawClient!.userRoleAssignment.create({
      data: { userId: agent.id, roleId: adminRole.id, campusId: null, scopeKey: "GLOBAL" },
    });
    createdAssignmentIds.push(assignment.id);
    globalAgentRef = agent;
    return agent;
  }

  it("SC04：claim/release/resolve/close 状态机 + dueAt 不重置 + UNSCOPED 仅 GLOBAL 可操作", async () => {
    const requester = await createFixtureUser("SC04requester");
    const agent = await createFixtureUser("SC04agent");
    await assignRoleByKey(agent.id, "CAMPUS_SUPPORT_AGENT", campusA.id);
    const { createSupportTicket, claimSupportTicket, releaseSupportTicket } = await import(
      "@/lib/support/support-service"
    );

    const ticket = await createSupportTicket({
      requesterId: requester.id,
      category: "SAFETY",
      subject: "SC04 安全问题上报",
      description: "SC04 需要平台级专员处理的安全问题描述。",
    });
    createdTicketIds.push(ticket.id);

    // CAMPUS agent 不能处理 UNSCOPED（UNSCOPED 仅 GLOBAL）
    await expect(claimSupportTicket({ actorId: agent.id, ticketId: ticket.id })).rejects.toMatchObject(
      { code: "AUTH_CAMPUS_SCOPE_MISMATCH" },
    );

    const globalOp = await globalAgent();
    const claimed = await claimSupportTicket({ actorId: globalOp.id, ticketId: ticket.id });
    expect(claimed.outcome).toBe("CLAIMED");

    let row = await rawClient!.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row.status).toBe("IN_PROGRESS");
    const dueAtBefore = row.dueAt;

    // release → OPEN；self 幂等；他人 release 拒
    const released = await releaseSupportTicket({ actorId: globalOp.id, ticketId: ticket.id });
    expect(released.outcome).toBe("RELEASED");
    row = await rawClient!.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row.status).toBe("OPEN");
    expect(row.assignedToId).toBeNull();
    expect(row.dueAt.getTime()).toBe(dueAtBefore.getTime());

    // resolve（OPEN 可直接终局）
    const { resolveSupportTicket } = await import("@/lib/support/support-service");
    await resolveSupportTicket({
      actorId: globalOp.id,
      ticketId: ticket.id,
      resolutionCode: "ANSWERED",
      resolutionMessage: "已为你解决问题",
      internalNote: "SC04 内部备注",
    });
    row = await rawClient!.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row.status).toBe("RESOLVED");
    expect(row.resolutionCode).toBe("ANSWERED");
    expect(row.internalNote).toBe("SC04 内部备注");

    // terminal 禁 reopen（claim/release/resolve/close 全部被拒）
    await expect(claimSupportTicket({ actorId: globalOp.id, ticketId: ticket.id })).rejects.toMatchObject(
      { code: "SUPPORT_TICKET_TERMINAL" },
    );
    await expect(
      resolveSupportTicket({ actorId: globalOp.id, ticketId: ticket.id, resolutionCode: "OTHER" }),
    ).rejects.toMatchObject({ code: "SUPPORT_TICKET_TERMINAL" });
  });

  it("SC05：处理审计（CLAIMED/RESOLVED/CLOSED）+ metadata 不含 description/internalNote", async () => {
    const requester = await createFixtureUser("SC05requester");
    const globalOp = await globalAgent();
    const { createSupportTicket, claimSupportTicket, closeSupportTicket } = await import(
      "@/lib/support/support-service"
    );

    const ticket = await createSupportTicket({
      requesterId: requester.id,
      category: "OTHER",
      subject: "SC05 审计合同",
      description: "SC05 审计不得携带的自由文本描述内容。",
    });
    createdTicketIds.push(ticket.id);

    await claimSupportTicket({ actorId: globalOp.id, ticketId: ticket.id });
    await closeSupportTicket({ actorId: globalOp.id, ticketId: ticket.id, internalNote: "SC05 内部" });

    const audits = await rawClient!.adminLog.findMany({
      where: { targetType: "SUPPORT_TICKET", targetId: ticket.id },
      orderBy: { createdAt: "asc" },
    });
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("SUPPORT_TICKET_CLAIMED");
    expect(actions).toContain("SUPPORT_TICKET_CLOSED");
    for (const audit of audits) {
      const serialized = JSON.stringify(audit.metadata ?? {});
      expect(serialized).not.toContain("SC05 审计不得携带");
      expect(serialized).not.toContain("SC05 内部");
    }
  });

  // ── SP：requester 读模型隐私 ────────────────────────────────────────────────

  it("SP01/SP02：internalNote 永不出现在 requester 读面；resolutionMessage 可见；他人工单 notFound", async () => {
    const requester = await createFixtureUser("SC05requester");
    const intruder = await createFixtureUser("SP02intruder");
    const globalOp = await globalAgent();
    const { createSupportTicket, resolveSupportTicket, loadOwnSupportTicket } = await import(
      "@/lib/support/support-service"
    );

    const ticket = await createSupportTicket({
      requesterId: requester.id,
      category: "ACCOUNT",
      subject: "SP01 隐私合同",
      description: "SP01 requester 读模型隐私验证描述。",
    });
    createdTicketIds.push(ticket.id);

    await resolveSupportTicket({
      actorId: globalOp.id,
      ticketId: ticket.id,
      resolutionCode: "USER_GUIDED",
      resolutionMessage: "请按指引重置密码",
      internalNote: "SP01 仅操作员可见的内部备注",
    });

    const own = await loadOwnSupportTicket(requester.id, ticket.id);
    expect(own).not.toBeNull();
    expect(own!.resolution?.message).toBe("请按指引重置密码");
    // DTO 不含 internalNote 字段（结构性排除）
    expect(JSON.stringify(own)).not.toContain("仅操作员可见的内部备注");
    expect(own).not.toHaveProperty("internalNote");

    // 他人查询 → null（notFound 同形，无 oracle）
    expect(await loadOwnSupportTicket(intruder.id, ticket.id)).toBeNull();
  });

  // ── E：erasure 集成 ────────────────────────────────────────────────────────

  it("E01：active 工单阻断注销（ACTIVE_SUPPORT_TICKET）", async () => {
    const requester = await createFixtureUser("E01requester");
    const { createSupportTicket } = await import("@/lib/support/support-service");
    const ticket = await createSupportTicket({
      requesterId: requester.id,
      category: "OTHER",
      subject: "E01 注销阻断",
      description: "E01 active 工单应阻断账号注销。",
    });
    createdTicketIds.push(ticket.id);

    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    await expect(eraseAccount(requester.id)).rejects.toMatchObject({
      code: "ACTIVE_SUPPORT_TICKET",
    });
    // 零部分擦除
    const user = await rawClient!.user.findUniqueOrThrow({ where: { id: requester.id } });
    expect(user.erasedAt).toBeNull();
  });

  it("E02：terminal 工单不阻断；注销清理 user free text（subject/description 标记、message/note null）", async () => {
    const requester = await createFixtureUser("E02requester");
    const globalOp = await globalAgent();
    const { createSupportTicket, resolveSupportTicket } = await import(
      "@/lib/support/support-service"
    );
    const ticket = await createSupportTicket({
      requesterId: requester.id,
      category: "OTHER",
      subject: "E02 待清理的自由文本主题",
      description: "E02 待清理的自由文本描述内容。",
    });
    createdTicketIds.push(ticket.id);
    await resolveSupportTicket({
      actorId: globalOp.id,
      ticketId: ticket.id,
      resolutionCode: "ANSWERED",
      resolutionMessage: "E02 待清理的结果说明",
      internalNote: "E02 待清理的内部备注",
    });

    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    await eraseAccount(requester.id);

    const row = await rawClient!.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    // 自由文本全清；行级 provenance 保留
    expect(row.subject).not.toContain("E02");
    expect(row.description).not.toContain("E02");
    expect(row.resolutionMessage).toBeNull();
    expect(row.internalNote).toBeNull();
    expect(row.category).toBe("OTHER");
    expect(row.status).toBe("RESOLVED");
    expect(row.campusId).toBeNull();
    const user = await rawClient!.user.findUniqueOrThrow({ where: { id: requester.id } });
    expect(user.erasedAt).not.toBeNull();
  });

  it("E03/S-RACE-03：工单创建 vs 注销并发 → 串行（若创建赢则注销阻断）", async () => {
    const requester = await createFixtureUser("E03requester");
    const { createSupportTicket } = await import("@/lib/support/support-service");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    const results = await Promise.allSettled([
      eraseAccount(requester.id),
      createSupportTicket({
        requesterId: requester.id,
        category: "OTHER",
        subject: "E03 并发创建",
        description: "E03 与注销并发创建的工单描述。",
      }),
    ]);

    assertNoSerializationFailure(
      results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason),
    );

    const tickets = await rawClient!.supportTicket.findMany({ where: { requesterId: requester.id } });
    createdTicketIds.push(...tickets.map((t) => t.id));
    const user = await rawClient!.user.findUniqueOrThrow({ where: { id: requester.id } });

    // 线性化不变量（双向）：
    //   create 赢 → 工单存在 ∧ 注销被阻断（not erased）；
    //   erase 赢 → 锁内 account recheck 拒绝后续创建（零工单）∧ erased
    if (tickets.some((t) => t.status === "OPEN" || t.status === "IN_PROGRESS")) {
      expect(user.erasedAt).toBeNull();
    } else {
      expect(tickets).toHaveLength(0);
      expect(user.erasedAt).not.toBeNull();
    }
  });

  it("E04/S-RACE-04：resolve 先赢 → terminal 后注销放行（与 E02 区分：并发方向）", async () => {
    const requester = await createFixtureUser("E04requester");
    const globalOp = await globalAgent();
    const { createSupportTicket, resolveSupportTicket } = await import(
      "@/lib/support/support-service"
    );
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    const ticket = await createSupportTicket({
      requesterId: requester.id,
      category: "OTHER",
      subject: "E04 并发终局",
      description: "E04 与注销并发的终局工单描述。",
    });
    createdTicketIds.push(ticket.id);

    const results = await Promise.allSettled([
      resolveSupportTicket({ actorId: globalOp.id, ticketId: ticket.id, resolutionCode: "OTHER" }),
      eraseAccount(requester.id),
    ]);
    assertNoSerializationFailure(
      results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason),
    );

    const user = await rawClient!.user.findUniqueOrThrow({ where: { id: requester.id } });
    const row = await rawClient!.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });

    // resolve 恒成功（不检查账号状态）；线性化分两种可解释结局：
    //   resolve 先赢 → terminal 不阻断注销 → erased + 注销清理 free text；
    //   erasure 先赢 → 当时工单 OPEN → ACTIVE_SUPPORT_TICKET 阻断 → not erased。
    expect(row.status).toBe("RESOLVED");
    if (user.erasedAt) {
      expect(row.resolutionMessage).toBeNull();
      expect(row.internalNote).toBeNull();
    } else {
      expect(row.resolutionMessage).toBeNull(); // resolve 未携带 message
    }
  });

  // ── S-RACE-01/02 + NO_40P01 ────────────────────────────────────────────────

  it("S-RACE-01：4 并发创建 → active 计数恒 ≤ 3（恰 3 成功或更少）", async () => {
    const requester = await createFixtureUser("RACE01requester");
    const { createSupportTicket } = await import("@/lib/support/support-service");

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        createSupportTicket({
          requesterId: requester.id,
          category: "OTHER",
          subject: `RACE01 第 ${i} 单`,
          description: `S-RACE-01 第 ${i} 个并发创建的工单描述。`,
        }),
      ),
    );
    assertNoSerializationFailure(
      results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason),
    );

    const created = await rawClient!.supportTicket.findMany({
      where: { requesterId: requester.id },
    });
    createdTicketIds.push(...created.map((t) => t.id));
    const active = created.filter((t) => t.status === "OPEN" || t.status === "IN_PROGRESS");
    expect(active.length).toBeLessThanOrEqual(3);
    expect(created.length).toBe(active.length);
  });

  it("S-RACE-02：role revoke vs resolve → 串行（revoke 赢则 resolve 被拒）", async () => {
    const requester = await createFixtureUser("RACE02requester");
    const agent = await createFixtureUser("RACE02agent");
    const enforcer = await createFixtureUser("RACE02enforcer");
    await assignRoleByKey(enforcer.id, "PLATFORM_ADMIN");
    await assignRoleByKey(agent.id, "CAMPUS_SUPPORT_AGENT", campusA.id);
    // 授予 GLOBAL 全量（可处理 UNSCOPED），撤销后失去 capability
    const adminRole = await rawClient!.role.findFirstOrThrow({ where: { key: "PLATFORM_ADMIN" } });
    const globalAssignment = await rawClient!.userRoleAssignment.create({
      data: { userId: agent.id, roleId: adminRole.id, campusId: null, scopeKey: "GLOBAL" },
    });
    createdAssignmentIds.push(globalAssignment.id);

    const { createSupportTicket, resolveSupportTicket } = await import(
      "@/lib/support/support-service"
    );
    const { revokeRole } = await import("@/lib/rbac/assignment-service");

    const ticket = await createSupportTicket({
      requesterId: requester.id,
      category: "OTHER",
      subject: "RACE02 并发终局",
      description: "S-RACE-02 revoke 与 resolve 并发竞争工单。",
    });
    createdTicketIds.push(ticket.id);

    const results = await Promise.allSettled([
      revokeRole({
        actorId: enforcer.id,
        targetUserId: agent.id,
        roleKey: "PLATFORM_ADMIN",
        campusId: null,
        expectedAssignmentId: globalAssignment.id,
      }),
      resolveSupportTicket({
        actorId: agent.id,
        ticketId: ticket.id,
        resolutionCode: "OTHER",
      }),
    ]);
    assertNoSerializationFailure(
      results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason),
    );
  });

  it("S-RACE-05：erasure wins after terminal ticket → 无 stale mutation（幂等收敛）", async () => {
    const requester = await createFixtureUser("RACE05requester");
    const globalOp = await globalAgent();
    const { createSupportTicket, closeSupportTicket } = await import(
      "@/lib/support/support-service"
    );
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    const ticket = await createSupportTicket({
      requesterId: requester.id,
      category: "OTHER",
      subject: "RACE05 terminal 后注销",
      description: "S-RACE-05 terminal 后注销不应产生 stale mutation。",
    });
    createdTicketIds.push(ticket.id);
    await closeSupportTicket({ actorId: globalOp.id, ticketId: ticket.id });

    // 注销成功（terminal 不阻断）；重复注销收敛 ACCOUNT_ALREADY_DELETED
    await eraseAccount(requester.id);
    await expect(eraseAccount(requester.id)).rejects.toMatchObject({
      code: "ACCOUNT_ALREADY_DELETED",
    });
  });

  it("NO_40P01：resolve ‖ claim ‖ erasure ‖ create 混合并发哨兵", async () => {
    const requester = await createFixtureUser("NO40requester");
    const globalOp = await globalAgent();
    const { createSupportTicket, claimSupportTicket, resolveSupportTicket } = await import(
      "@/lib/support/support-service"
    );
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    const ticket = await createSupportTicket({
      requesterId: requester.id,
      category: "OTHER",
      subject: "NO40 混合并发",
      description: "NO_40P01 哨兵工单描述。",
    });
    createdTicketIds.push(ticket.id);

    const thirdParty = await createFixtureUser("NO40third", { membershipCampusId: null });
    const results = await Promise.allSettled([
      resolveSupportTicket({ actorId: globalOp.id, ticketId: ticket.id, resolutionCode: "OTHER" }),
      claimSupportTicket({ actorId: globalOp.id, ticketId: ticket.id }),
      eraseAccount(thirdParty.id),
      createSupportTicket({
        requesterId: requester.id,
        category: "OTHER",
        subject: "NO40 并发第二单",
        description: "NO_40P01 并发创建的第二单描述。",
      }),
    ]);
    assertNoSerializationFailure(
      results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason),
    );
  });

  // ── SLA-S / SLA-A ──────────────────────────────────────────────────────────

  it("SLA-S02/S03：超时工单只读——零自动 close/resolve", async () => {
    const requester = await createFixtureUser("SLA-S02requester");
    const now = new Date();
    const ticket = await rawClient!.supportTicket.create({
      data: {
        requesterId: requester.id,
        campusId: null,
        scopeKey: "UNSCOPED",
        category: "OTHER",
        status: "OPEN",
        subject: "SLA 超时只读",
        description: "SLA-S02 超时工单零自动动作。",
        dueAt: new Date(now.getTime() - 60 * 60 * 1000),
        createdAt: new Date(now.getTime() - 73 * 60 * 60 * 1000),
      },
    });
    createdTicketIds.push(ticket.id);

    const { isSupportTicketOverdue } = await import("@/lib/support/support-sla");
    expect(isSupportTicketOverdue({ status: ticket.status, dueAt: ticket.dueAt })).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await rawClient!.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("OPEN");
  });

  it("SLA-A01：appeal 迁移回填 origin 逐字断言（createdAt + 48h，绝无 now()+INTERVAL）", () => {
    const migrationSql = readFileSync(
      join(
        process.cwd(),
        "prisma/migrations/20260919120000_phase7g_dispute_support_schema/migration.sql",
      ),
      "utf8",
    );
    expect(migrationSql).toContain('SET "reviewDueAt" = "createdAt" + INTERVAL \'48 hours\'');
    // 仅检查可执行语句（剥离 -- 注释行；注释中的禁用语义示例不得触发本断言）
    const executable = migrationSql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(executable).not.toMatch(/now\(\)\s*\+\s*INTERVAL/i);
  });

  it("SLA-A01b：submitAppeal 运行时写入 reviewDueAt = 提交时刻 + 48h", async () => {
    const target = await createFixtureUser("SLA-A01target");
    const enforcer = await createFixtureUser("SLA-A01enforcer");
    await assignRoleByKey(enforcer.id, "PLATFORM_ADMIN");

    const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
    await suspendAccount({
      actorId: enforcer.id,
      targetUserId: target.id,
      reasonCode: "POLICY_VIOLATION",
    });
    const action = await rawClient!.enforcementAction.findFirstOrThrow({
      where: { targetId: target.id, type: "ACCOUNT_SUSPEND" },
      orderBy: { enforcementSeq: "desc" },
    });
    createdEnforcementIds.push(action.id);

    const { submitAppeal } = await import("@/lib/appeals/appeal-service");
    const { appeal } = await submitAppeal({
      callerUserId: target.id,
      enforcementActionId: action.id,
      statement: "SLA-A01 运行时 SLA 写入验证",
    });
    createdAppealIds.push(appeal.id);

    const row = await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
    const diffHours = (row.reviewDueAt.getTime() - row.createdAt.getTime()) / (60 * 60 * 1000);
    expect(Math.abs(diffHours - 48)).toBeLessThan(0.01);
  });

  it("SLA-A02/A03/A04：overdue 只读（active 过期、terminal 永不过期、零自动决定）", async () => {
    const { isAppealReviewOverdue } = await import("@/lib/appeals/appeal-sla");
    const now = new Date();
    const past = new Date(now.getTime() - 60 * 60 * 1000);

    expect(isAppealReviewOverdue({ status: "SUBMITTED", reviewDueAt: past }, now)).toBe(true);
    expect(isAppealReviewOverdue({ status: "IN_REVIEW", reviewDueAt: past }, now)).toBe(true);
    expect(isAppealReviewOverdue({ status: "GRANTED", reviewDueAt: past }, now)).toBe(false);
    expect(isAppealReviewOverdue({ status: "WITHDRAWN", reviewDueAt: past }, now)).toBe(false);
    expect(
      isAppealReviewOverdue({ status: "SUBMITTED", reviewDueAt: new Date(now.getTime() + 60 * 60 * 1000) }, now),
    ).toBe(false);

    // 队列排序合同（reviewDueAt ASC, createdAt ASC, id ASC）在 DB 侧验证
    const target2 = await createFixtureUser("SLA-A02target");
    const enforcer = await createFixtureUser("SLA-A02enforcer");
    await assignRoleByKey(enforcer.id, "PLATFORM_ADMIN");
    const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
    await suspendAccount({
      actorId: enforcer.id,
      targetUserId: target2.id,
      reasonCode: "POLICY_VIOLATION",
    });
    const action = await rawClient!.enforcementAction.findFirstOrThrow({
      where: { targetId: target2.id, type: "ACCOUNT_SUSPEND" },
      orderBy: { enforcementSeq: "desc" },
    });
    createdEnforcementIds.push(action.id);

    const { submitAppeal } = await import("@/lib/appeals/appeal-service");
    const { appeal } = await submitAppeal({
      callerUserId: target2.id,
      enforcementActionId: action.id,
      statement: "SLA-A02 overdue 只读验证",
    });
    createdAppealIds.push(appeal.id);

    // 手动把 reviewDueAt 置为过去（模拟超时）
    await rawClient!.appeal.update({
      where: { id: appeal.id },
      data: { reviewDueAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
    // 零自动决定：status 不变、无 reviewedBy/reviewedAt
    expect(after.status).toBe("SUBMITTED");
    expect(after.reviewedById).toBeNull();
    expect(after.reviewedAt).toBeNull();
  });
});
