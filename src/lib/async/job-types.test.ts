import { describe, expect, it } from "vitest";

import { getFieldPrivacyPolicy } from "@/lib/privacy/privacy-data-registry";
import {
  classifyJobFailure,
  jobErrorCode,
  jobErrorMessage,
  PermanentJobFailure,
  productReservationExpirePayloadSchema,
} from "./job-types";

describe("Phase 9A job failure 分类与错误消毒（§17/§18）", () => {
  it("PermanentJobFailure → PERMANENT；普通 Error / 未知异常 → RETRYABLE", () => {
    expect(classifyJobFailure(new PermanentJobFailure("X"))).toBe("PERMANENT");
    expect(classifyJobFailure(new Error("boom"))).toBe("RETRYABLE");
    expect(classifyJobFailure("random failure")).toBe("RETRYABLE");
    expect(classifyJobFailure(undefined)).toBe("RETRYABLE");
  });

  it("error code 提取：PermanentJobFailure.code 优先，其次 Prisma/Node code，再次 name", () => {
    expect(jobErrorCode(new PermanentJobFailure("SOME_STRUCTURAL_CORRUPTION"))).toBe(
      "SOME_STRUCTURAL_CORRUPTION",
    );
    const prismaLikeError = Object.assign(new Error("unique constraint"), { code: "P2002" });
    expect(jobErrorCode(prismaLikeError)).toBe("P2002");
    expect(jobErrorCode(new TypeError("oops"))).toBe("TypeError");
    expect(jobErrorCode("no error object")).toBe("UNKNOWN");
  });

  it("RB02 ERR-SAFE：raw exception message 默认拒绝落库（固定 generic message）", () => {
    // 秘密格式无限 → 不做正则黑名单，DENY raw message BY DEFAULT
    const leaky = new Error("password=super-secret jwt=abc.def.ghi user note=私密内容");
    expect(jobErrorMessage(leaky)).toBe("异步任务执行失败");
    expect(jobErrorMessage(leaky)).not.toContain("super-secret");
    expect(jobErrorMessage(leaky)).not.toContain("abc.def.ghi");
    expect(jobErrorMessage(leaky)).not.toContain("私密内容");
    expect(jobErrorMessage("plain string failure")).toBe("异步任务执行失败");
    expect(jobErrorMessage(undefined)).toBe("异步任务执行失败");
  });

  it("RB02 ERR-SAFE：PermanentJobFailure 受控内部文案允许（仍消毒：首行 / 控制字符 / <=500）", () => {
    const controlled = new PermanentJobFailure(
      "PRODUCT_RESERVATION_STRUCTURAL_INVALID",
      "PRODUCT reservation target invalid: order-1",
    );
    expect(jobErrorMessage(controlled)).toBe("PRODUCT reservation target invalid: order-1");

    const multilineControlled = new PermanentJobFailure(
      "X",
      "first line\nstack-ish line",
    );
    expect(jobErrorMessage(multilineControlled)).toBe("first line");

    const longControlled = new PermanentJobFailure("X", "y".repeat(800));
    expect(jobErrorMessage(longControlled)).toHaveLength(500);
  });

  it("RB02 privacy registry：async error 元数据 = OPERATOR_ONLY / EXCLUDE（machine-only 声明成立）", () => {
    for (const [model, field] of [
      ["AsyncJob", "lastErrorCode"],
      ["AsyncJob", "lastErrorMessage"],
      ["OutboxEvent", "lastErrorCode"],
      ["OutboxEvent", "lastErrorMessage"],
    ] as const) {
      const policy = getFieldPrivacyPolicy(model, field);
      expect(policy, `${model}.${field} 必须有显式分类`).not.toBeNull();
      expect(policy!.classification).toBe("OPERATOR_ONLY");
      expect(policy!.selfExport).toBe("EXCLUDE");
      expect(policy!.secondaryCopyAllowed).toBe(false);
      expect(policy!.logSafe).toBe(false);
    }
  });

  it("PRODUCT_RESERVATION_EXPIRE payload 冻结形状：仅 { orderId: string }", () => {
    expect(productReservationExpirePayloadSchema.safeParse({ orderId: "order-1" }).success).toBe(
      true,
    );
    // 多余键被剥离、缺键/空串拒绝——payload 禁止携带任何 user-authored 内容
    expect(
      productReservationExpirePayloadSchema.safeParse({ orderId: "order-1", note: "hack" })
        .success,
    ).toBe(true);
    expect(productReservationExpirePayloadSchema.safeParse({}).success).toBe(false);
    expect(productReservationExpirePayloadSchema.safeParse({ orderId: "" }).success).toBe(false);
  });
});
