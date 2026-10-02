import { describe, expect, it } from "vitest";

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

  it("sanitized message：只取首行、去控制字符、截断 <= 500（full stack 绝不入库）", () => {
    const multiline = "first line\nsecond line\r\npwd=hunter2";
    expect(jobErrorMessage(multiline)).toBe("first line");

    const withControlChars = "bad\u0000\u001fmessage";
    expect(jobErrorMessage(withControlChars)).toBe("bad  message");

    const long = "x".repeat(800);
    expect(jobErrorMessage(long)).toHaveLength(500);
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
