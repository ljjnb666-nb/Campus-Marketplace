import { describe, expect, it } from "vitest";

import {
  ENFORCEMENT_MAX_PAGE_SIZE,
  decodeEnforcementSeqCursor,
  encodeEnforcementSeq,
  encodeEnforcementSeqCursor,
  enforcementQueueQuerySchema,
  enforcementTargetHistoryQuerySchema,
} from "@/validators/enforcement";

function enc(payload: string): string {
  return Buffer.from(payload, "utf8").toString("base64url");
}

describe("enforcementSeq wire 合同（R6 / DECISION_14 冻结）", () => {
  it("encode：bigint → canonical decimal string（toString(10)）", () => {
    expect(encodeEnforcementSeq(1000000000n)).toBe("1000000000");
    expect(encodeEnforcementSeq(0n)).toBe("0");
    expect(encodeEnforcementSeq(123456789012345678901234567890n)).toBe(
      "123456789012345678901234567890",
    );
  });

  it("cursor 往返唯一：encode(decode(x)) === x", () => {
    const seq = 1000000042n;
    const cursor = encodeEnforcementSeqCursor(seq);
    expect(decodeEnforcementSeqCursor(cursor)).toBe(seq);
    expect(encodeEnforcementSeqCursor(decodeEnforcementSeqCursor(cursor)!)).toBe(cursor);
  });

  it("合法 canonical decimal 解码成功", () => {
    expect(decodeEnforcementSeqCursor(enc("0"))).toBe(0n);
    expect(decodeEnforcementSeqCursor(enc("999"))).toBe(999n);
  });

  it("拒绝负号 / 加号 / 小数 / 科学计数 / 前导零 / 空串 / 非数字", () => {
    expect(decodeEnforcementSeqCursor(enc("-1"))).toBeNull();
    expect(decodeEnforcementSeqCursor(enc("+1"))).toBeNull();
    expect(decodeEnforcementSeqCursor(enc("1.5"))).toBeNull();
    expect(decodeEnforcementSeqCursor(enc("1e3"))).toBeNull();
    expect(decodeEnforcementSeqCursor(enc("01"))).toBeNull();
    expect(decodeEnforcementSeqCursor(enc(""))).toBeNull();
    expect(decodeEnforcementSeqCursor(enc("12a"))).toBeNull();
    expect(decodeEnforcementSeqCursor(enc(" 1"))).toBeNull();
  });

  it("拒绝畸形 base64url 与超范围输入（不经 Number，无精度损失）", () => {
    expect(decodeEnforcementSeqCursor("!!!")).toBeNull();
    const huge = 123456789012345678901234567890n;
    expect(decodeEnforcementSeqCursor(encodeEnforcementSeqCursor(huge))).toBe(huge);
  });
});

describe("enforcement 队列/历史查询合同", () => {
  it("limit 缺席可选；越界拒绝", () => {
    expect(enforcementQueueQuerySchema.safeParse({}).success).toBe(true);
    expect(enforcementQueueQuerySchema.safeParse({ limit: "25" }).success).toBe(true);
    expect(enforcementQueueQuerySchema.safeParse({ limit: ENFORCEMENT_MAX_PAGE_SIZE + 1 }).success).toBe(false);
  });

  it("type 枚举校验（未知执法类型拒绝）", () => {
    expect(enforcementQueueQuerySchema.safeParse({ type: "ACCOUNT_SUSPEND" }).success).toBe(true);
    expect(enforcementQueueQuerySchema.safeParse({ type: "NOT_A_TYPE" }).success).toBe(false);
  });

  it("未知参数拒绝（strict）", () => {
    expect(enforcementQueueQuerySchema.safeParse({ note: "x" }).success).toBe(false);
    expect(enforcementTargetHistoryQuerySchema.safeParse({ sourceId: "x" }).success).toBe(false);
  });

  it("target history 合同仅接受 limit/cursor", () => {
    expect(enforcementTargetHistoryQuerySchema.safeParse({ cursor: "abc" }).success).toBe(true);
    expect(enforcementTargetHistoryQuerySchema.safeParse({ targetId: "x" }).success).toBe(false);
  });
});
