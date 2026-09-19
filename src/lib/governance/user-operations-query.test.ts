import { describe, expect, it } from "vitest";

import {
  decodeUserCursor,
  encodeUserCursor,
} from "@/lib/governance/user-operations-query";

/**
 * Phase 7F Final Repair 1（FR03）：用户 cursor canonical 纪律（7D FR02 同款）。
 * 攻击者可控的 cursor 输入绝不静默归一化——只有 canonical 表示被接受。
 */

const ISO = "2026-09-18T00:00:00.000Z";
const ID = "user-abc123";

function makeUserCursorPayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function canonicalUserCursor(): string {
  return makeUserCursorPayload({ createdAt: ISO, id: ID });
}

describe("decodeUserCursor（canonical 纪律 C01..C10）", () => {
  it("C01：canonical cursor 被接受（等价 Date）", () => {
    expect(decodeUserCursor(canonicalUserCursor())).toEqual({
      createdAt: new Date(ISO),
      id: ID,
    });
  });

  it("C02：非法 base64 字符被拒（白名单外：=、+、/、空白、其余符号）", () => {
    expect(decodeUserCursor("abc=")).toBeNull();
    expect(decodeUserCursor("ab+c")).toBeNull();
    expect(decodeUserCursor("ab/c")).toBeNull();
    expect(decodeUserCursor("ab c")).toBeNull();
    expect(decodeUserCursor("ab$c")).toBeNull();
    expect(decodeUserCursor("")).toBeNull();
  });

  it("C03：合法 base64 但非 JSON 被拒", () => {
    expect(decodeUserCursor(Buffer.from("not-json", "utf8").toString("base64url"))).toBeNull();
    expect(decodeUserCursor(Buffer.from("[1,2]", "utf8").toString("base64url"))).toBeNull();
  });

  it("C04：多余字段被拒", () => {
    expect(
      decodeUserCursor(makeUserCursorPayload({ createdAt: ISO, id: ID, extra: "x" })),
    ).toBeNull();
  });

  it("C05：缺字段被拒", () => {
    expect(decodeUserCursor(makeUserCursorPayload({ createdAt: ISO }))).toBeNull();
    expect(decodeUserCursor(makeUserCursorPayload({ id: ID }))).toBeNull();
    expect(decodeUserCursor(makeUserCursorPayload({}))).toBeNull();
  });

  it("C06：空 id / 非字符串 id 被拒", () => {
    expect(decodeUserCursor(makeUserCursorPayload({ createdAt: ISO, id: "" }))).toBeNull();
    expect(decodeUserCursor(makeUserCursorPayload({ createdAt: ISO, id: 5 }))).toBeNull();
  });

  it("C07：不可解析日期被拒", () => {
    expect(
      decodeUserCursor(makeUserCursorPayload({ createdAt: "not-a-date", id: ID })),
    ).toBeNull();
  });

  it("C08：等价但非 canonical 的日期表示被拒（绝不静默归一化）", () => {
    // 缺毫秒
    expect(
      decodeUserCursor(makeUserCursorPayload({ createdAt: "2026-09-18T00:00:00Z", id: ID })),
    ).toBeNull();
    // epoch 毫秒数字符串（即使可解析也不产生 canonical ISO 形状）
    expect(
      decodeUserCursor(
        makeUserCursorPayload({ createdAt: String(new Date(ISO).getTime()), id: ID }),
      ),
    ).toBeNull();
    // 偏移时区等价表示
    expect(
      decodeUserCursor(makeUserCursorPayload({ createdAt: "2026-09-18T08:00:00+08:00", id: ID })),
    ).toBeNull();
    // 带空格
    expect(
      decodeUserCursor(makeUserCursorPayload({ createdAt: " 2026-09-18T00:00:00.000Z", id: ID })),
    ).toBeNull();
  });

  it("C09：非 canonical 外层编码被拒（re-encode equality 为最终权威）", () => {
    // canonical JSON 换键序 → 外层 base64 随之非 canonical
    expect(
      decodeUserCursor(
        Buffer.from(JSON.stringify({ id: ID, createdAt: ISO }), "utf8").toString("base64url"),
      ),
    ).toBeNull();
    // base64url 尾位填充变体（解码等价但非唯一表示）
    const canonical = canonicalUserCursor();
    expect(decodeUserCursor(canonical + "A")).toBeNull();
  });

  it("C10：encode(decode(raw)) === raw 精确相等", () => {
    const raw = canonicalUserCursor();
    const decoded = decodeUserCursor(raw);
    expect(decoded).not.toBeNull();
    expect(encodeUserCursor(decoded!)).toBe(raw);
  });
});
