import { describe, expect, it } from "vitest";

import {
  FEATURE_FLAG_KEYS,
  NEW_ACTIVITY_FLAG_KEYS,
  assertFeatureFlagKey,
  assertFlagMutationValue,
  isFlagDisabledForScope,
} from "@/lib/feature-flags/feature-flag-registry";

describe("Phase 10F registered kill switches", () => {
  it("enumerates all 9 frozen keys and denies arbitrary values", () => {
    expect(FEATURE_FLAG_KEYS).toHaveLength(9);
    for (const key of FEATURE_FLAG_KEYS) expect(() => assertFeatureFlagKey(key)).not.toThrow();
    for (const key of ["RESEND_API_KEY", "READ_ALL_USERS", "__proto__", "RESTRICTED"]) {
      expect(() => assertFeatureFlagKey(key)).toThrow("FEATURE_FLAG_UNREGISTERED");
    }
    for (const value of [true, false, null]) {
      expect(() => assertFlagMutationValue(value)).not.toThrow();
    }
    for (const value of ["true", 1, 0, undefined, {}, []]) {
      expect(() => assertFlagMutationValue(value)).toThrow("FEATURE_FLAG_VALUE_INVALID");
    }
  });

  it("GLOBAL disabled wins over campus explicit false; other campus isolated", () => {
    const global = [{
      scopeKey: "GLOBAL", campusId: null, disabled: true,
    }];
    const local = [{
      scopeKey: "CAMPUS:A", campusId: "A", disabled: false,
    }];
    expect(isFlagDisabledForScope([...global, ...local], "DISABLE_NEW_ORDERS", "A")).toBe(true);
    expect(isFlagDisabledForScope(local, "DISABLE_NEW_ORDERS", "A")).toBe(false);
    expect(isFlagDisabledForScope([{
      scopeKey: "CAMPUS:B", campusId: "B", disabled: true,
    }], "DISABLE_NEW_ORDERS", "A")).toBe(false);
  });

  it("restrictive high-level modes do not disable safety/recovery workflows", () => {
    expect(NEW_ACTIVITY_FLAG_KEYS.REGISTRATION).toContain("MAINTENANCE_MODE");
    for (const kind of ["LISTING","ORDER","CONVERSATION","MESSAGE"] as const) {
      expect(NEW_ACTIVITY_FLAG_KEYS[kind]).toContain("READ_ONLY_MODE");
      expect(NEW_ACTIVITY_FLAG_KEYS[kind]).toContain("MAINTENANCE_MODE");
    }
    expect(NEW_ACTIVITY_FLAG_KEYS.DISPUTE).toEqual(["DISABLE_DISPUTE_INITIATION"]);
    expect(NEW_ACTIVITY_FLAG_KEYS.MEETUP).toEqual(["DISABLE_MEETUPS"]);
  });
});
