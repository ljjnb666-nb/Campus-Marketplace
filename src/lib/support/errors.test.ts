import { describe, expect, it } from "vitest";

import { isSupportTicketError, supportTicketError } from "@/lib/support/errors";

describe("supportTicketError 构造臂", () => {
  it("string override / object override / 默认文案三臂 + 类型守卫", () => {
    expect(supportTicketError("SUPPORT_TICKET_TERMINAL", "自定义文案").message).toBe("自定义文案");
    expect(supportTicketError("SUPPORT_TICKET_TERMINAL", { userMessage: "对象文案" }).message).toBe(
      "对象文案",
    );
    expect(supportTicketError("SUPPORT_TICKET_TERMINAL").message).toBe(
      "该工单已终局，不允许再次处理",
    );
    expect(isSupportTicketError(supportTicketError("SUPPORT_TICKET_TERMINAL"))).toBe(true);
    expect(isSupportTicketError(new Error("x"))).toBe(false);
  });
});
