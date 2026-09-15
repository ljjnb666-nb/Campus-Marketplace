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
    // tests tsconfig target ES2017：BigInt 一律用构造器（禁字面量）
    expect(encodeEnforcementSeq(BigInt(1000000000))).toBe("1000000000");
    expect(encodeEnforcementSeq(BigInt(0))).toBe("0");
    expect(encodeEnforcementSeq(BigInt("123456789012345678901234567890"))).toBe(
      "123456789012345678901234567890",
    );
  });

  it("cursor 往返唯一：encode(decode(x)) === x", () => {
    const seq = BigInt(1000000042);
    const cursor = encodeEnforcementSeqCursor(seq);
    expect(decodeEnforcementSeqCursor(cursor)).toBe(seq);
    expect(encodeEnforcementSeqCursor(decodeEnforcementSeqCursor(cursor)!)).toBe(cursor);
  });

  it("合法 canonical decimal 解码成功", () => {
    expect(decodeEnforcementSeqCursor(enc("0"))).toBe(BigInt(0));
    expect(decodeEnforcementSeqCursor(enc("999"))).toBe(BigInt(999));
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
    const huge = BigInt("123456789012345678901234567890");
    expect(decodeEnforcementSeqCursor(encodeEnforcementSeqCursor(huge))).toBe(huge);
  });

  it("FR02-C01: canonical cursor → PASS", () => {
    const canonical = encodeEnforcementSeqCursor(BigInt(1000000042));
    expect(canonical).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeEnforcementSeqCursor(canonical)).toBe(BigInt(1000000042));
  });

  it("FR02-C02/C03/C04: = 填充 / 非法字符 / 空白 → null（RAW 本体白名单）", () => {
    expect(decodeEnforcementSeqCursor("MQ==")).toBeNull(); // = 填充
    expect(decodeEnforcementSeqCursor("MQ$")).toBeNull(); // 非字母表字符
    expect(decodeEnforcementSeqCursor("M Q")).toBeNull(); // 空白
    expect(decodeEnforcementSeqCursor("\tMQ")).toBeNull(); // 制表符
    expect(decodeEnforcementSeqCursor("")).toBeNull(); // 空串
  });

  it("FR02-C05: 标准 base64 字母表（+/）→ null", () => {
    // "+"/"/" 属标准 base64，非 canonical base64url 字母集
    expect(decodeEnforcementSeqCursor("MTIz+")).toBeNull();
    expect(decodeEnforcementSeqCursor("MTIz/")).toBeNull();
    expect(decodeEnforcementSeqCursor("MQ==+")).toBeNull();
  });

  it("FR02-C06: 非规范 base64url 替代编码（尾位非零）→ null（re-encode equality 权威）", () => {
    // "MR" 宽松解码同样得到 payload "1"，但尾位非零 → encode(1)="MQ" ≠ "MR" → 拒绝
    expect(decodeEnforcementSeqCursor("MR")).toBeNull();
    expect(encodeEnforcementSeqCursor(BigInt(1))).toBe("MQ");
  });

  it("FR02-C07: 负号 / 加号 / 小数 / 指数 / 前导零 → null（payload canonical decimal）", () => {
    expect(decodeEnforcementSeqCursor(enc("-1"))).toBeNull();
    expect(decodeEnforcementSeqCursor(enc("+1"))).toBeNull();
    expect(decodeEnforcementSeqCursor(enc("1.5"))).toBeNull();
    expect(decodeEnforcementSeqCursor(enc("1e3"))).toBeNull();
    expect(decodeEnforcementSeqCursor(enc("01"))).toBeNull();
  });

  it("FR02-C08: huge bigint → 精确往返（不经 Number）", () => {
    const huge = BigInt("123456789012345678901234567890123456789");
    const cursor = encodeEnforcementSeqCursor(huge);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeEnforcementSeqCursor(cursor)).toBe(huge);
    expect(encodeEnforcementSeqCursor(decodeEnforcementSeqCursor(cursor)!)).toBe(cursor);
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
