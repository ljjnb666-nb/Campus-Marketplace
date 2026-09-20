import { beforeEach, describe, expect, it, vi } from "vitest";

const { revalidatePath, requireUser, createSupportTicket } = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  createSupportTicket: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/support/support-service", () => ({ createSupportTicket }));

import { createSupportTicketAction } from "@/actions/support";
import { supportTicketError } from "@/lib/support/errors";

/**
 * Phase 7G：用户面创建工单 action 合同（.strict() 校验 + canonical 服务）。
 */

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    fd.set(k, v);
  }
  return fd;
}

beforeEach(() => {
  for (const fn of [requireUser, createSupportTicket, revalidatePath]) {
    fn.mockReset();
  }
  requireUser.mockResolvedValue({ id: "requester-1" });
});

describe("createSupportTicketAction", () => {
  it("happy path：UNSCOPED 创建 + revalidate + ticketId 回传", async () => {
    createSupportTicket.mockResolvedValue({ id: "t1", scopeKey: "UNSCOPED", campusId: null });

    const result = await createSupportTicketAction(
      formData({ category: "ACCOUNT", subject: "无法登录", description: "登录一直失败请协助处理。" }),
    );

    expect(result).toEqual({ success: true, ticketId: "t1" });
    expect(createSupportTicket).toHaveBeenCalledWith({
      requesterId: "requester-1",
      category: "ACCOUNT",
      subject: "无法登录",
      description: "登录一直失败请协助处理。",
      campusId: undefined,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/support");
  });

  it("注入身份字段被 .strict() 拒绝（requesterId 不出自客户端）", async () => {
    const result = await createSupportTicketAction(
      formData({
        category: "ACCOUNT",
        subject: "主题",
        description: "描述内容足够长。",
        requesterId: "attacker",
      }),
    );
    expect(result.success).toBe(false);
    expect(createSupportTicket).not.toHaveBeenCalled();
  });

  it("上限/成员资格域内文案回传", async () => {
    createSupportTicket.mockRejectedValue(supportTicketError("SUPPORT_TICKET_LIMIT_EXCEEDED"));
    const limited = await createSupportTicketAction(
      formData({ category: "OTHER", subject: "主题", description: "这是足够长的描述内容。" }),
    );
    expect(limited).toEqual({ success: false, error: "你有太多进行中的工单，请等待现有工单处理完成" });

    createSupportTicket.mockRejectedValue(supportTicketError("SUPPORT_CAMPUS_MEMBERSHIP_INACTIVE"));
    const denied = await createSupportTicketAction(
      formData({
        category: "OTHER",
        subject: "主题",
        description: "这是足够长的描述内容。",
        campusId: "campus-x",
      }),
    );
    expect(denied.success).toBe(false);
  });

  it("非域错误 → actionErrorMessage fallback", async () => {
    createSupportTicket.mockRejectedValue(new Error("boom"));
    const result = await createSupportTicketAction(
      formData({ category: "OTHER", subject: "主题", description: "这是足够长的描述内容。" }),
    );
    expect(result.success).toBe(false);
  });

  it("描述过短 → 参数错误", async () => {
    const result = await createSupportTicketAction(
      formData({ category: "OTHER", subject: "主题", description: "太短" }),
    );
    expect(result.success).toBe(false);
    expect(createSupportTicket).not.toHaveBeenCalled();
  });
});
