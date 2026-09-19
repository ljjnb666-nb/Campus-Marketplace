/**
 * Phase 7F Final Repair 1（FR03）：canonical cursor 解析纪律（7D Final Review
 * Repair 1 / FR02 同款冻结，SSOT 共享实现）。
 *
 * RAW cursor 本体必须是 canonical base64url：Buffer.from(raw, "base64url") 解码
 * 是宽松的（静默剥离非法字符、接受标准 base64 字母表与 =/+//、非规范尾位），
 * 因此：
 *   1. RAW 白名单 ^[A-Za-z0-9_-]+$（禁 =/+///空白/其余字符/空串）；
 *   2. 解码 → JSON.parse → 必须是 object 且 keys 与期望集合 EXACT 相等
 *      （多字段/缺字段/数组/标量一律拒绝）；
 *   3. 全部值必须是 string；date 字段必须满足
 *      new Date(value).toISOString() === value（canonical ISO——等价但
 *      非规范的时间表示一律拒绝，绝不静默归一化攻击者输入）；
 *   4. id 字段非空 string；
 *   5. re-encode equality：encode(decode(raw)) === raw（canonical 外层与
 *      canonical JSON 键序的最终权威——往返非唯一的任何非规范形状拒绝）。
 * 任一步失败返回 null（调用方映射安全失败态）。
 */

export const CURSOR_RAW_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 解析出键集合恰好为 expectedKeys 的全 string 载荷；任何失败返回 null。 */
export function parseCanonicalCursorJson(
  raw: string,
  expectedKeys: readonly string[],
): Record<string, string> | null {
  if (!CURSOR_RAW_BASE64URL_PATTERN.test(raw)) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    return null;
  }

  for (const value of Object.values(record)) {
    if (typeof value !== "string") {
      return null;
    }
  }

  return record as Record<string, string>;
}

/** canonical ISO 守卫：可解析且 toISOString() 与原串逐字相等。 */
export function parseCanonicalCursorDate(value: string): Date | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    return null;
  }
  return date;
}
