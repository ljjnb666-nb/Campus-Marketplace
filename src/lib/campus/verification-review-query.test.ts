import { describe, expect, it } from "vitest";

import {
  decodeVerificationCursor,
  encodeVerificationCursor,
} from "@/lib/campus/verification-review-query";

/**
 * Phase 7F Final Repair 1（FR03）：认证 cursor canonical 纪律（7D FR02 同款）。
 * 攻击者可控的 cursor 输入绝不静默归一化——只有 canonical 表示被接受。
 */

const DUE = "2026-09-20T00:00:00.000Z";
const SUBMITTED = "2026-09-18T00:00:00.000Z";
const ID = "ver-abc123";

function makeCursorPayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function canonicalCursor(): string {
  return makeCursorPayload({ reviewDueAt: DUE, submittedAt: SUBMITTED, id: ID });
}

describe("decodeVerificationCursor（canonical 纪律 C01..C10）", () => {
  it("C01：canonical cursor 被接受（等价 Date）", () => {
    expect(decodeVerificationCursor(canonicalCursor())).toEqual({
      reviewDueAt: new Date(DUE),
      submittedAt: new Date(SUBMITTED),
      id: ID,
    });
  });

  it("C02：非法 base64 字符被拒（白名单外：=、+、/、空白、其余符号、空串）", () => {
    expect(decodeVerificationCursor("a=c")).toBeNull();
    expect(decodeVerificationCursor("a+c")).toBeNull();
    expect(decodeVerificationCursor("a/c")).toBeNull();
    expect(decodeVerificationCursor("a c")).toBeNull();
    expect(decodeVerificationCursor("a!c")).toBeNull();
    expect(decodeVerificationCursor("")).toBeNull();
  });

  it("C03：合法 base64 但非 JSON 被拒", () => {
    expect(
      decodeVerificationCursor(Buffer.from("not-json", "utf8").toString("base64url")),
    ).toBeNull();
    expect(
      decodeVerificationCursor(Buffer.from('{"a":1}', "utf8").toString("base64url")),
    ).toBeNull();
  });

  it("C04：多余字段被拒", () => {
    expect(
      decodeVerificationCursor(
        makeCursorPayload({ reviewDueAt: DUE, submittedAt: SUBMITTED, id: ID, extra: true }),
      ),
    ).toBeNull();
  });

  it("C05：缺字段被拒", () => {
    expect(
      decodeVerificationCursor(makeCursorPayload({ reviewDueAt: DUE, submittedAt: SUBMITTED })),
    ).toBeNull();
    expect(decodeVerificationCursor(makeCursorPayload({ id: ID }))).toBeNull();
    expect(decodeVerificationCursor(makeCursorPayload({}))).toBeNull();
  });

  it("C06：空 id / 非字符串 id 被拒", () => {
    expect(
      decodeVerificationCursor(makeCursorPayload({ reviewDueAt: DUE, submittedAt: SUBMITTED, id: "" })),
    ).toBeNull();
    expect(
      decodeVerificationCursor(makeCursorPayload({ reviewDueAt: DUE, submittedAt: SUBMITTED, id: null })),
    ).toBeNull();
  });

  it("C07：不可解析日期被拒", () => {
    expect(
      decodeVerificationCursor(
        makeCursorPayload({ reviewDueAt: "garbage", submittedAt: SUBMITTED, id: ID }),
      ),
    ).toBeNull();
    expect(
      decodeVerificationCursor(
        makeCursorPayload({ reviewDueAt: DUE, submittedAt: "2026-13-45T99:00:00.000Z", id: ID }),
      ),
    ).toBeNull();
  });

  it("C08：等价但非 canonical 的日期表示被拒（绝不静默归一化）", () => {
    // 缺毫秒
    expect(
      decodeVerificationCursor(
        makeCursorPayload({ reviewDueAt: "2026-09-20T00:00:00Z", submittedAt: SUBMITTED, id: ID }),
      ),
    ).toBeNull();
    // 偏移时区等价表示
    expect(
      decodeVerificationCursor(
        makeCursorPayload({ reviewDueAt: DUE, submittedAt: "2026-09-18T08:00:00+08:00", id: ID }),
      ),
    ).toBeNull();
  });

  it("C09：非 canonical 外层编码被拒（re-encode equality 为最终权威）", () => {
    // canonical JSON 换键序 → 外层 base64 随之非 canonical
    expect(
      decodeVerificationCursor(
        Buffer.from(
          JSON.stringify({ id: ID, submittedAt: SUBMITTED, reviewDueAt: DUE }),
          "utf8",
        ).toString("base64url"),
      ),
    ).toBeNull();
    // base64url 尾位填充变体
    expect(decodeVerificationCursor(canonicalCursor() + "A")).toBeNull();
  });

  it("C10：encode(decode(raw)) === raw 精确相等", () => {
    const raw = canonicalCursor();
    const decoded = decodeVerificationCursor(raw);
    expect(decoded).not.toBeNull();
    expect(encodeVerificationCursor(decoded!)).toBe(raw);
  });
});
