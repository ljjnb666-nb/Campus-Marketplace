import { describe, expect, it } from "vitest";
import {
  assertRuntimeConfigKey,
  parseRuntimeConfigValue,
  RUNTIME_CONFIG_REGISTRY,
} from "@/lib/runtime-config/runtime-config-registry";

describe("10E runtime config registry", () => {
  it("accepts only registered non-secret integer keys and bounded values", () => {
    expect(parseRuntimeConfigValue("RISK_SIGNAL_EVIDENCE_LIMIT", 5)).toBe(5);
    expect(parseRuntimeConfigValue("RISK_SIGNAL_EVIDENCE_LIMIT", 50)).toBe(50);
    for (const value of [-1, 0, 4, 51, 1.5, NaN, "10", null, Infinity]) {
      expect(() => parseRuntimeConfigValue("RISK_SIGNAL_EVIDENCE_LIMIT", value)).toThrow(
        "RUNTIME_CONFIG_VALUE_INVALID",
      );
    }
    for (const key of ["RESEND_API_KEY", "EMAIL_PROVIDER", "MAINTENANCE_MODE", "__proto__"]) {
      expect(() => assertRuntimeConfigKey(key)).toThrow(
        "RUNTIME_CONFIG_KEY_NOT_REGISTERED",
      );
    }
    expect(RUNTIME_CONFIG_REGISTRY.RISK_SIGNAL_EVIDENCE_LIMIT.safeFallbackValue)
      .toBeLessThan(RUNTIME_CONFIG_REGISTRY.RISK_SIGNAL_EVIDENCE_LIMIT.defaultValue);
  });
});
