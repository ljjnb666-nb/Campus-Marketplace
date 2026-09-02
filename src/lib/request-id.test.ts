import { describe, expect, it } from "vitest";

import {
  generateRequestId,
  isValidRequestId,
  resolveRequestId,
  REQUEST_ID_HEADER,
} from "@/lib/request-id";

describe("request-id（TASK 1）", () => {
  it("生成 32 位十六进制 ID", () => {
    const id = generateRequestId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("生成值不唯一性抽查：两次生成不同", () => {
    expect(generateRequestId()).not.toBe(generateRequestId());
  });

  it("接受合法客户端 ID（字母数字._-，8-64 位）", () => {
    expect(isValidRequestId("abcd1234")).toBe(true);
    expect(isValidRequestId("A".repeat(64))).toBe(true);
    expect(isValidRequestId("trace-01.abc_def")).toBe(true);
  });

  it("拒绝恶意/畸形客户端 ID（含 REQUEST_ID 安全契约）", () => {
    expect(isValidRequestId(null)).toBe(false);
    expect(isValidRequestId("")).toBe(false);
    expect(isValidRequestId("short7")).toBe(false); // < 8 位
    expect(isValidRequestId(`${"a".repeat(65)}`)).toBe(false); // > 64 位
    expect(isValidRequestId("has space")).toBe(false);
    expect(isValidRequestId("user@example.com")).toBe(false); // email 形态
    expect(isValidRequestId("line1\r\nX-Injected: 1")).toBe(false); // header 注入
    expect(isValidRequestId("<script>")).toBe(false);
    expect(isValidRequestId("../../etc/passwd")).toBe(false);
    // 含用户敏感数据形态的值不属于合法 ID 格式
    expect(isValidRequestId("Bearer%20abc12345")).toBe(false);
  });

  it("resolve：合法 ID 透传（跨服务链路追踪），非法/缺失重新生成", () => {
    expect(resolveRequestId("valid-id-123")).toBe("valid-id-123");
    const regenerated = resolveRequestId("x\r\nInjected: 1");
    expect(regenerated).toMatch(/^[0-9a-f]{32}$/);
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f]{32}$/);
    expect(resolveRequestId(null)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("header 名为小写 x-request-id", () => {
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });
});
