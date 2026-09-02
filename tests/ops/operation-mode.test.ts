import { afterEach, describe, expect, it, vi } from "vitest";

import { extractModeArg, parseOperationMode } from "../../scripts/ops/operation-mode";

/**
 * 修复轮 3：CLI 操作模式契约（fail-closed）。
 * 未提供 --mode → NODE_ENV 默认；显式提供则必须严格属于白名单。
 */
describe("operation-mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("parseOperationMode", () => {
    it("undefined（未提供）→ NODE_ENV=production 时为 production", () => {
      vi.stubEnv("NODE_ENV", "production");
      expect(parseOperationMode(undefined)).toEqual({ ok: true, mode: "production" });
    });

    it("undefined（未提供）→ 其它 NODE_ENV 时为 development", () => {
      vi.stubEnv("NODE_ENV", "test");
      expect(parseOperationMode(undefined)).toEqual({ ok: true, mode: "development" });
    });

    it("合法值：production / development / ci", () => {
      expect(parseOperationMode("production")).toEqual({ ok: true, mode: "production" });
      expect(parseOperationMode("development")).toEqual({ ok: true, mode: "development" });
      expect(parseOperationMode("ci")).toEqual({ ok: true, mode: "ci" });
    });

    it.each([
      "prodcution", // 拼写错误（typo 绕过生产 gate 的关键场景）
      "prod",
      "staging",
      "", // 显式空值
      "PRODUCTION", // 大小写敏感：只接受精确白名单
      "production ", // 带尾随空格
      "production-x",
    ])("非法显式值 %j → 拒绝（不得猜测/降级/fallback）", (value) => {
      expect(parseOperationMode(value)).toEqual({ ok: false });
    });
  });

  describe("extractModeArg", () => {
    it("无 --mode → undefined（未提供）", () => {
      expect(extractModeArg(["node", "ops-check.ts"])).toBeUndefined();
    });

    it("--mode 带值 → 返回该值", () => {
      expect(extractModeArg(["node", "x.ts", "--mode", "ci"])).toBe("ci");
    });

    it("--mode 位于末尾（缺值）→ 空串（非法）", () => {
      expect(extractModeArg(["node", "x.ts", "--mode"])).toBe("");
    });

    it("--mode 后是另一个 flag → 空串（非法）", () => {
      expect(extractModeArg(["node", "x.ts", "--mode", "--skip-connectivity"])).toBe("");
    });
  });
});
