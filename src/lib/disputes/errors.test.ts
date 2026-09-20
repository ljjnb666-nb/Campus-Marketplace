import { describe, expect, it } from "vitest";

import { disputeError, isDisputeError } from "@/lib/disputes/errors";

describe("disputeError 构造臂", () => {
  it("string override / object override / 默认文案三臂 + 类型守卫", () => {
    expect(disputeError("DISPUTE_TERMINAL", "自定义文案").message).toBe("自定义文案");
    expect(disputeError("DISPUTE_TERMINAL", { userMessage: "对象文案" }).message).toBe("对象文案");
    expect(disputeError("DISPUTE_TERMINAL").message).toBe("该纠纷已终局，不允许再次处理");
    expect(isDisputeError(disputeError("DISPUTE_TERMINAL"))).toBe(true);
    expect(isDisputeError(new Error("x"))).toBe(false);
  });
});
