import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  recordAdminAudit,
  createNotification,
  loadAuthorizationContextMock,
  ticketCreate,
  ticketCount,
  ticketFindUnique,
  ticketUpdate,
} = vi.hoisted(() => ({
  recordAdminAudit: vi.fn(),
  createNotification: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
  ticketCreate: vi.fn(),
  ticketCount: vi.fn(),
  ticketFindUnique: vi.fn(),
  ticketUpdate: vi.fn(),
}));

vi.mock("@/lib/governance/admin-audit", () => ({ recordAdminAudit }));
vi.mock("@/repositories/notification-repository", () => ({ createNotification }));
vi.mock("@/lib/rbac/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac/service")>();
  return { ...actual, loadAuthorizationContext: loadAuthorizationContextMock };
});

const txStub = {
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  supportTicket: {
    create: ticketCreate,
    count: ticketCount,
    findUnique: ticketFindUnique,
    findFirst: vi.fn(),
    update: ticketUpdate,
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    supportTicket: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
  withTransaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(txStub)),
}));

import type { AuthorizationContext } from "@/lib/rbac/service";
import { supportTicketError } from "@/lib/support/errors";
import {
  MAX_ACTIVE_SUPPORT_TICKETS_PER_USER,
  claimSupportTicket,
  closeSupportTicket,
  createSupportTicket,
  releaseSupportTicket,
  resolveSupportTicket,
} from "@/lib/support/support-service";

/**
 * Phase 7G：support 创建上限 / claim / release / resolve / close 的锁序 +
 * 状态机 + UNSCOPED 仅 GLOBAL 合同（mock tx；真实 PG 线性化在集成测试覆盖）。
 */

const AGENT_GLOBAL_CTX: AuthorizationContext = {
  userId: "agent-1",
  accountActive: true,
  activeCampusIds: [],
  grants: [
    { roleKey: "GLOBAL_SUPPORT", scope: "GLOBAL", campusId: null, permissionKeys: ["support.manage"] },
  ],
};

beforeEach(() => {
  for (const fn of [
    txStub.$executeRaw,
    txStub.$queryRaw,
    ticketCreate,
    ticketCount,
    ticketFindUnique,
    ticketUpdate,
    recordAdminAudit,
    createNotification,
    loadAuthorizationContextMock,
  ]) {
    fn.mockReset();
  }

  txStub.$executeRaw.mockResolvedValue(0);
  ticketCreate.mockResolvedValue({ id: "t-new", dueAt: new Date() });
  ticketCount.mockResolvedValue(0);
  ticketUpdate.mockResolvedValue({});
  recordAdminAudit.mockResolvedValue(undefined);
  createNotification.mockResolvedValue({});
  loadAuthorizationContextMock.mockResolvedValue(AGENT_GLOBAL_CTX);

  // 默认行锁行：UNSCOPED OPEN 工单
  txStub.$queryRaw.mockResolvedValue([
    {
      id: "t1",
      campusId: null,
      scopeKey: "UNSCOPED",
      status: "OPEN",
      assignedToId: null,
      requesterId: "requester-1",
    },
  ]);
  ticketFindUnique.mockResolvedValue({ requesterId: "requester-1" });
});

describe("createSupportTicket（abuse guard：锁内 3 条上限）", () => {
  it("UNSCOPED 创建：scopeKey=UNSCOPED + dueAt=+72h + active 计数复查", async () => {
    const result = await createSupportTicket({
      requesterId: "requester-1",
      category: "ACCOUNT",
      subject: "无法登录",
      description: "登录一直失败，请协助排查处理。",
    });

    expect(result.scopeKey).toBe("UNSCOPED");
    expect(result.campusId).toBeNull();
    expect(ticketCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "OPEN", scopeKey: "UNSCOPED" }),
      }),
    );
    expect(ticketCount).toHaveBeenCalledWith({
      where: {
        requesterId: "requester-1",
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
    });
  });

  it("达上限（3 条 active）→ SUPPORT_TICKET_LIMIT_EXCEEDED，零创建", async () => {
    ticketCount.mockResolvedValue(MAX_ACTIVE_SUPPORT_TICKETS_PER_USER);

    await expect(
      createSupportTicket({
        requesterId: "requester-1",
        category: "OTHER",
        subject: "第4单",
        description: "这是第四个进行中的工单描述。",
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_TICKET_LIMIT_EXCEEDED" });
    expect(ticketCreate).not.toHaveBeenCalled();
  });

  it("campusId 提供但 membership 非 ACTIVE → SUPPORT_CAMPUS_MEMBERSHIP_INACTIVE", async () => {
    await expect(
      createSupportTicket({
        requesterId: "requester-1",
        category: "MARKETPLACE",
        subject: "校区工单",
        description: "这是校区工单描述正文。",
        campusId: "campus-x",
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_CAMPUS_MEMBERSHIP_INACTIVE" });
    expect(ticketCreate).not.toHaveBeenCalled();
  });

  it("campusId 有效（ACTIVE membership）→ CAMPUS scope snapshot", async () => {
    loadAuthorizationContextMock.mockResolvedValue({
      ...AGENT_GLOBAL_CTX,
      activeCampusIds: ["campus-x"],
    });

    const result = await createSupportTicket({
      requesterId: "requester-1",
      category: "MARKETPLACE",
      subject: "校区工单",
      description: "这是校区工单描述正文。",
      campusId: "campus-x",
    });

    expect(result.scopeKey).toBe("CAMPUS:campus-x");
    expect(result.campusId).toBe("campus-x");
  });

  it("账号停用 → AUTH_ACCOUNT_INACTIVE（锁内 recheck）", async () => {
    loadAuthorizationContextMock.mockResolvedValue({ ...AGENT_GLOBAL_CTX, accountActive: false });

    await expect(
      createSupportTicket({
        requesterId: "requester-1",
        category: "OTHER",
        subject: "主题",
        description: "停用账号不能创建工单。",
      }),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });
  });
});

describe("claim / release（USER:actor → ticket 行锁 → 锁后授权）", () => {
  it("claim UNSCOPED：GLOBAL agent OPEN → IN_PROGRESS + assignedToId=actor + 审计", async () => {
    const result = await claimSupportTicket({ actorId: "agent-1", ticketId: "t1" });

    expect(result.outcome).toBe("CLAIMED");
    expect(ticketUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { assignedToId: "agent-1", status: "IN_PROGRESS" },
      select: { id: true },
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SUPPORT_TICKET_CLAIMED" }),
      txStub,
    );
  });

  it("CAMPUS agent 不可处理 UNSCOPED 工单（requirePermissionInContext 拒绝 CAMPUS grant）", async () => {
    loadAuthorizationContextMock.mockResolvedValue({
      userId: "agent-2",
      accountActive: true,
      activeCampusIds: ["A"],
      grants: [
        { roleKey: "CAMPUS_SUPPORT_AGENT", scope: "CAMPUS", campusId: "A", permissionKeys: ["support.manage"] },
      ],
    });

    // requirePermissionInContext 对"持有 CAMPUS grant 但 scope 不匹配"精确收敛
    // AUTH_CAMPUS_SCOPE_MISMATCH（同样 fail closed；机器码仅服务端判别）
    await expect(claimSupportTicket({ actorId: "agent-2", ticketId: "t1" })).rejects.toMatchObject({
      code: "AUTH_CAMPUS_SCOPE_MISMATCH",
    });
    expect(ticketUpdate).not.toHaveBeenCalled();
  });

  it("claim 他人已领用 → SUPPORT_TICKET_ALREADY_CLAIMED；self 幂等", async () => {
    txStub.$queryRaw.mockResolvedValue([
      { id: "t1", campusId: null, scopeKey: "UNSCOPED", status: "IN_PROGRESS", assignedToId: "other", requesterId: "requester-1" },
    ]);
    await expect(claimSupportTicket({ actorId: "agent-1", ticketId: "t1" })).rejects.toMatchObject({
      code: "SUPPORT_TICKET_ALREADY_CLAIMED",
    });

    txStub.$queryRaw.mockResolvedValue([
      { id: "t1", campusId: null, scopeKey: "UNSCOPED", status: "IN_PROGRESS", assignedToId: "agent-1", requesterId: "requester-1" },
    ]);
    const result = await claimSupportTicket({ actorId: "agent-1", ticketId: "t1" });
    expect(result.outcome).toBe("ALREADY_YOURS");
    expect(ticketUpdate).not.toHaveBeenCalled();
  });

  it("release 非领用人 → SUPPORT_TICKET_RELEASE_FORBIDDEN；self → OPEN + null", async () => {
    txStub.$queryRaw.mockResolvedValue([
      { id: "t1", campusId: null, scopeKey: "UNSCOPED", status: "IN_PROGRESS", assignedToId: "other", requesterId: "requester-1" },
    ]);
    await expect(releaseSupportTicket({ actorId: "agent-1", ticketId: "t1" })).rejects.toMatchObject({
      code: "SUPPORT_TICKET_RELEASE_FORBIDDEN",
    });

    txStub.$queryRaw.mockResolvedValue([
      { id: "t1", campusId: null, scopeKey: "UNSCOPED", status: "IN_PROGRESS", assignedToId: "agent-1", requesterId: "requester-1" },
    ]);
    const result = await releaseSupportTicket({ actorId: "agent-1", ticketId: "t1" });
    expect(result.outcome).toBe("RELEASED");
    expect(ticketUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { assignedToId: null, status: "OPEN" },
      select: { id: true },
    });
  });

  it("claim 防御臂：malformed UNSCOPED pair / malformed CAMPUS pair → fail closed", async () => {
    // UNSCOPED key 但 campusId 非空（结构不可达，纵深防御）
    txStub.$queryRaw.mockResolvedValue([
      { id: "t1", campusId: "A", scopeKey: "UNSCOPED", status: "OPEN", assignedToId: null, requesterId: "requester-1" },
    ]);
    await expect(claimSupportTicket({ actorId: "agent-1", ticketId: "t1" })).rejects.toMatchObject({
      code: "AUTH_PERMISSION_DENIED",
    });

    // CAMPUS key 但 campusId 为空
    txStub.$queryRaw.mockResolvedValue([
      { id: "t1", campusId: null, scopeKey: "CAMPUS:A", status: "OPEN", assignedToId: null, requesterId: "requester-1" },
    ]);
    await expect(claimSupportTicket({ actorId: "agent-1", ticketId: "t1" })).rejects.toMatchObject({
      code: "AUTH_PERMISSION_DENIED",
    });
  });

  it("release：未领用幂等 ALREADY_RELEASED + racePoint seam", async () => {
    txStub.$queryRaw.mockResolvedValue([
      { id: "t1", campusId: null, scopeKey: "UNSCOPED", status: "OPEN", assignedToId: null, requesterId: "requester-1" },
    ]);
    const racePoint = vi.fn();
    const result = await releaseSupportTicket({ actorId: "agent-1", ticketId: "t1", racePoint });
    expect(result.outcome).toBe("ALREADY_RELEASED");
    expect(racePoint).toHaveBeenCalled();
  });

  it("claim：账号停用 → AUTH_ACCOUNT_INACTIVE（锁内授权复核）", async () => {
    loadAuthorizationContextMock.mockResolvedValue({ ...AGENT_GLOBAL_CTX, accountActive: false });
    await expect(claimSupportTicket({ actorId: "agent-1", ticketId: "t1" })).rejects.toMatchObject({
      code: "AUTH_ACCOUNT_INACTIVE",
    });
  });

  it("工单不存在 → SUPPORT_TICKET_NOT_FOUND（行锁空）", async () => {
    txStub.$queryRaw.mockResolvedValue([]);
    await expect(claimSupportTicket({ actorId: "agent-1", ticketId: "t1" })).rejects.toMatchObject({
      code: "SUPPORT_TICKET_NOT_FOUND",
    });
  });

  it("终局防御臂：resolve/close 行锁空（325）与 requester 漂移（329）→ fail closed", async () => {
    txStub.$queryRaw.mockResolvedValue([]);
    await expect(
      resolveSupportTicket({ actorId: "agent-1", ticketId: "t1", resolutionCode: "OTHER" }),
    ).rejects.toMatchObject({ code: "SUPPORT_TICKET_NOT_FOUND" });

    await expect(closeSupportTicket({ actorId: "agent-1", ticketId: "t1" })).rejects.toMatchObject({
      code: "SUPPORT_TICKET_NOT_FOUND",
    });

    txStub.$queryRaw.mockResolvedValue([
      { id: "t1", campusId: null, scopeKey: "UNSCOPED", status: "OPEN", assignedToId: null, requesterId: "someone-else" },
    ]);
    await expect(
      resolveSupportTicket({ actorId: "agent-1", ticketId: "t1", resolutionCode: "OTHER" }),
    ).rejects.toMatchObject({ code: "SUPPORT_TICKET_INVALID_TRANSITION" });
  });
});

describe("resolve / close（ONE sorted set：actor + requester）", () => {
  it("resolve：OPEN → RESOLVED + USER_VISIBLE message + internalNote + 审计 + 通知", async () => {
    const result = await resolveSupportTicket({
      actorId: "agent-1",
      ticketId: "t1",
      resolutionCode: "ANSWERED",
      resolutionMessage: "已为你重置密码入口",
      internalNote: "用户可能遭遇钓鱼",
    });

    expect(result.status).toBe("RESOLVED");
    expect(ticketUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: expect.objectContaining({
        status: "RESOLVED",
        resolutionCode: "ANSWERED",
        resolutionMessage: "已为你重置密码入口",
        internalNote: "用户可能遭遇钓鱼",
        resolvedById: "agent-1",
      }),
      select: { id: true },
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SUPPORT_TICKET_RESOLVED",
        metadata: expect.objectContaining({ resolutionCode: "ANSWERED" }),
      }),
      txStub,
    );
    // FR04：通知是固定安全文本的事件信号——绝不复制 resolutionMessage /
    // internalNote 自由文本（唯一权威用户可见文本 = SupportTicket.resolutionMessage）
    expect(createNotification).toHaveBeenCalledWith(
      txStub,
      {
        userId: "requester-1",
        type: "SYSTEM",
        title: "支持工单已处理",
        content: "你的支持工单已处理完成，请进入工单详情查看处理结果。",
      },
    );
    const notificationPayload = JSON.stringify(
      createNotification.mock.calls.at(-1)![1],
    );
    expect(notificationPayload).not.toContain("已为你重置密码入口");
    expect(notificationPayload).not.toContain("用户可能遭遇钓鱼");
  });

  it("close：OPEN → CLOSED（resolutionCode 不写）", async () => {
    const result = await closeSupportTicket({ actorId: "agent-1", ticketId: "t1" });

    expect(result.status).toBe("CLOSED");
    expect(ticketUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CLOSED" }),
      }),
    );
    const data = ticketUpdate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(JSON.stringify(data)).not.toContain("resolutionCode");
  });

  it("terminal 再终局 → SUPPORT_TICKET_TERMINAL", async () => {
    txStub.$queryRaw.mockResolvedValue([
      { id: "t1", campusId: null, scopeKey: "UNSCOPED", status: "RESOLVED", assignedToId: "agent-1", requesterId: "requester-1" },
    ]);
    await expect(
      resolveSupportTicket({ actorId: "agent-1", ticketId: "t1", resolutionCode: "OTHER" }),
    ).rejects.toMatchObject({ code: "SUPPORT_TICKET_TERMINAL" });
  });

  it("lock discovery 缺行 → SUPPORT_TICKET_NOT_FOUND", async () => {
    ticketFindUnique.mockResolvedValue(null);
    await expect(
      resolveSupportTicket({ actorId: "agent-1", ticketId: "ghost", resolutionCode: "OTHER" }),
    ).rejects.toMatchObject({ code: "SUPPORT_TICKET_NOT_FOUND" });
  });

  it("supportTicketError 错误码 status 映射", () => {
    expect(supportTicketError("SUPPORT_TICKET_LIMIT_EXCEEDED").status).toBe(429);
    expect(supportTicketError("SUPPORT_CAMPUS_MEMBERSHIP_INACTIVE").status).toBe(403);
  });
});
