import { describe, expect, it } from "vitest";

import { decideMetricsToken, metricsTokenEnvChecks } from "@/lib/metrics-token";

/**
 * BLOCKER 3：METRICS_BEARER_TOKEN 单一安全契约。
 * unset → 端点关闭（允许）；非空必须 >=24 字符、非危险默认值、
 * 不复用 NEXTAUTH_SECRET。结果只含 reason 枚举，绝不含值。
 */
describe("metrics-token contract", () => {
  const secret = ["nextauth-secret-value-", "zxcvbnmasdfghjkl"].join("");

  it("unset/空 → 关闭（unset，允许态）", () => {
    expect(decideMetricsToken(undefined, secret)).toEqual({ open: false, reason: "unset" });
    expect(decideMetricsToken("", secret)).toEqual({ open: false, reason: "unset" });
  });

  it("METRICS_SHORT_TOKEN_TEST：<24 字符 → too_short", () => {
    expect(decideMetricsToken("short-token", secret)).toEqual({ open: false, reason: "too_short" });
    expect(decideMetricsToken("a".repeat(23), secret)).toEqual({ open: false, reason: "too_short" });
  });

  it("24 字符整 → 通过长度下限", () => {
    const token = "a".repeat(24);
    expect(decideMetricsToken(token, secret)).toEqual({ open: true });
  });

  it("METRICS_SECRET_REUSE_TEST：token == NEXTAUTH_SECRET → reuses_nextauth_secret", () => {
    expect(decideMetricsToken(secret, secret)).toEqual({
      open: false,
      reason: "reuses_nextauth_secret",
    });
  });

  it("危险默认值/placeholder 形态 → unsafe_default", () => {
    expect(decideMetricsToken("changeme-please-replace-this-token", secret)).toEqual({
      open: false,
      reason: "unsafe_default",
    });
    expect(decideMetricsToken("placeholder-token-value-qwertyuiop", secret)).toEqual({
      open: false,
      reason: "unsafe_default",
    });
  });

  it("合法专用 token → open", () => {
    expect(decideMetricsToken(["dedicated-metrics-token-", "qwertyuiopasdfgh"].join(""), secret)).toEqual({
      open: true,
    });
  });

  it("env-check 契约：合法 → 两项 PASS；过短/复用 → 对应 FAIL；未设置 → PASS（关闭态）", () => {
    const good = metricsTokenEnvChecks({
      METRICS_BEARER_TOKEN: ["dedicated-metrics-token-", "qwertyuiopasdfgh"].join(""),
      NEXTAUTH_SECRET: secret,
    });
    expect(good.every((c) => c.ok)).toBe(true);

    const short = metricsTokenEnvChecks({ METRICS_BEARER_TOKEN: "short-token" });
    expect(short.find((c) => c.name === "METRICS_BEARER_TOKEN.strength")?.ok).toBe(false);

    const reused = metricsTokenEnvChecks({
      METRICS_BEARER_TOKEN: secret,
      NEXTAUTH_SECRET: secret,
    });
    expect(reused.find((c) => c.name === "METRICS_BEARER_TOKEN.dedicated")?.ok).toBe(false);

    const unset = metricsTokenEnvChecks({});
    expect(unset.every((c) => c.ok)).toBe(true);
  });
});
