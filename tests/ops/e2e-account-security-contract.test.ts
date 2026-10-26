// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("E2E account proof contract", () => {
  const source = readFileSync("tests/e2e/helpers/account-security.ts", "utf8");
  it("keeps isolated DB and actual browser proof boundaries", () => {
    expect(source).toContain("assertE2EDatabaseIsolation");
    expect(source).toContain('loginViaUI as loginWithoutMfa');
    expect(source).toContain('name="mfaCode"');
    expect(source).toContain("确认启用双重验证");
    expect(source).toContain("确认验证邮箱");
    expect(source).not.toMatch(/\.(?:update|updateMany|create|upsert)\s*\(/);
  });
  it("waits for fresh counters under a fixture-only mutex rather than resetting replay state", () => {
    expect(source).toContain("BigInt(counter) > user.mfaLastCounter");
    expect(source).toContain("pg_advisory_xact_lock(979313");
    expect(source).not.toMatch(/mfaLastCounter\s*:\s*(?:null|0|BigInt\()/);
  });
});
