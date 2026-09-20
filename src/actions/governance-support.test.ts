import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePath,
  requireUser,
  loadAuthorizationContext,
  claimSupportTicket,
  releaseSupportTicket,
  resolveSupportTicket,
  closeSupportTicket,
} = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  claimSupportTicket: vi.fn(),
  releaseSupportTicket: vi.fn(),
  resolveSupportTicket: vi.fn(),
  closeSupportTicket: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/rbac/service", () => ({ loadAuthorizationContext }));
vi.mock("@/lib/support/support-service", () => ({
  claimSupportTicket,
  releaseSupportTicket,
  resolveSupportTicket,
  closeSupportTicket,
}));

import {
  claimSupportTicketAction,
  closeSupportTicketAction,
  releaseSupportTicketAction,
  resolveSupportTicketAction,
} from "@/actions/governance-support";
import { supportTicketError } from "@/lib/support/errors";

/**
 * Phase 7G：工单 actions 薄适配层合同。
 */

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    fd.set(k, v);
  }
  return fd;
}

beforeEach(() => {
  for (const fn of [requireUser, loadAuthorizationContext, claimSupportTicket, releaseSupportTicket, resolveSupportTicket, closeSupportTicket, revalidatePath]) {
    fn.mockReset();
  }
  requireUser.mockResolvedValue({ id: "agent-1" });
  loadAuthorizationContext.mockResolvedValue({
    userId: "agent-1",
    accountActive: true,
    activeCampusIds: [],
    grants: [
      { roleKey: "GLOBAL_SUPPORT", scope: "GLOBAL", campusId: null, permissionKeys: ["support.manage"] },
    ],
  });
});

describe("claimSupportTicketAction / releaseSupportTicketAction", () => {
  it("claim happy path → canonical 服务 + revalidate", async () => {
    claimSupportTicket.mockResolvedValue({ ticketId: "t1", assignedToId: "agent-1", outcome: "CLAIMED" });

    const result = await claimSupportTicketAction(formData({ ticketId: "t1" }));

    expect(result).toEqual({ success: true, outcome: "CLAIMED" });
    expect(claimSupportTicket).toHaveBeenCalledWith({ actorId: "agent-1", ticketId: "t1" });
    expect(revalidatePath).toHaveBeenCalledWith("/governance/support");
  });

  it("NOT_FOUND/FORBIDDEN → 统一 deny；ALREADY_CLAIMED → 域内文案", async () => {
    claimSupportTicket.mockRejectedValue(supportTicketError("SUPPORT_TICKET_NOT_FOUND"));
    expect(await claimSupportTicketAction(formData({ ticketId: "x" }))).toEqual({
      success: false,
      error: "没有权限处理该工单",
    });

    claimSupportTicket.mockRejectedValue(supportTicketError("SUPPORT_TICKET_ALREADY_CLAIMED"));
    expect(await claimSupportTicketAction(formData({ ticketId: "x" }))).toEqual({
      success: false,
      error: "该工单已被其他专员领用",
    });
  });

  it("release happy path", async () => {
    releaseSupportTicket.mockResolvedValue({ ticketId: "t1", assignedToId: null, outcome: "RELEASED" });
    const result = await releaseSupportTicketAction(formData({ ticketId: "t1" }));
    expect(result).toEqual({ success: true, outcome: "RELEASED" });
  });
});

describe("resolveSupportTicketAction / closeSupportTicketAction", () => {
  it("resolve 透传 code/message/internalNote", async () => {
    resolveSupportTicket.mockResolvedValue({ ticketId: "t1", status: "RESOLVED" });

    const result = await resolveSupportTicketAction(
      formData({
        ticketId: "t1",
        resolutionCode: "ANSWERED",
        resolutionMessage: "已答复",
        internalNote: "内部",
      }),
    );

    expect(result.success).toBe(true);
    expect(resolveSupportTicket).toHaveBeenCalledWith({
      actorId: "agent-1",
      ticketId: "t1",
      resolutionCode: "ANSWERED",
      resolutionMessage: "已答复",
      internalNote: "内部",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/notifications");
  });

  it("close 透传 internalNote；非法枚举 → 参数错误", async () => {
    closeSupportTicket.mockResolvedValue({ ticketId: "t1", status: "CLOSED" });
    const result = await closeSupportTicketAction(formData({ ticketId: "t1" }));
    expect(result.success).toBe(true);

    const bad = await resolveSupportTicketAction(
      formData({ ticketId: "t1", resolutionCode: "NOT_A_CODE" }),
    );
    expect(bad.success).toBe(false);
    expect(resolveSupportTicket).not.toHaveBeenCalled();
  });

  it("resolve/close：缺参 parse error 与零 access 统一 deny（canonical 服务零调用）", async () => {
    const missing = await closeSupportTicketAction(formData({}));
    expect(missing.success).toBe(false);
    expect(closeSupportTicket).not.toHaveBeenCalled();

    loadAuthorizationContext.mockResolvedValue({
      userId: "agent-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [],
    });
    const denied = await closeSupportTicketAction(formData({ ticketId: "t1" }));
    expect(denied).toEqual({ success: false, error: "没有权限处理该工单" });
    expect(closeSupportTicket).not.toHaveBeenCalled();

    const resolveDenied = await resolveSupportTicketAction(
      formData({ ticketId: "t1", resolutionCode: "OTHER" }),
    );
    expect(resolveDenied.success).toBe(false);
    expect(resolveSupportTicket).not.toHaveBeenCalled();
  });

  it("release/resolve 零 access → 统一 deny（canonical 服务零调用）", async () => {
    loadAuthorizationContext.mockResolvedValue({
      userId: "agent-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [],
    });
    expect(await releaseSupportTicketAction(formData({ ticketId: "t1" }))).toEqual({
      success: false,
      error: "没有权限处理该工单",
    });
    expect(await resolveSupportTicketAction(
      formData({ ticketId: "t1", resolutionCode: "OTHER" }),
    )).toEqual({ success: false, error: "没有权限处理该工单" });
    expect(releaseSupportTicket).not.toHaveBeenCalled();
    expect(resolveSupportTicket).not.toHaveBeenCalled();
  });

  it("release/close/resolve 错误分支：NOT_FOUND 统一 deny；TERMINAL 域内文案；非域错误走 actionErrorMessage", async () => {
    releaseSupportTicket.mockRejectedValue(supportTicketError("SUPPORT_TICKET_RELEASE_FORBIDDEN"));
    expect(await releaseSupportTicketAction(formData({ ticketId: "x" }))).toEqual({
      success: false,
      error: "没有权限处理该工单",
    });

    closeSupportTicket.mockRejectedValue(supportTicketError("SUPPORT_TICKET_TERMINAL"));
    expect(await closeSupportTicketAction(formData({ ticketId: "x" }))).toEqual({
      success: false,
      error: "该工单已终局，不允许再次处理",
    });

    resolveSupportTicket.mockRejectedValue(new Error("boom"));
    const fallback = await resolveSupportTicketAction(
      formData({ ticketId: "t1", resolutionCode: "OTHER" }),
    );
    expect(fallback.success).toBe(false);
  });
});
