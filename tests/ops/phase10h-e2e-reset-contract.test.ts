import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const setup = readFileSync("scripts/e2e-setup.ts", "utf8");
const browser = readFileSync("tests/e2e/phase10h-runtime-config.spec.ts", "utf8");

describe("10H immutable Runtime Config E2E reset contract", () => {
  it("H-R1: isolation gate strictly precedes database reset", () => {
    const main = setup.slice(setup.indexOf("async function main()"));
    expect(main.indexOf("assertE2EDatabaseIsolation(")).toBeGreaterThanOrEqual(0);
    expect(main.indexOf("assertE2EDatabaseIsolation(")).toBeLessThan(main.indexOf("wipeAll(prisma)"));
  });
  it("H-R2: revision and override are reset before campus, with no CASCADE", () => {
    expect(setup).toContain('TRUNCATE TABLE "RuntimeConfigRevision", "RuntimeConfigOverride"');
    expect(setup).not.toMatch(/TRUNCATE TABLE "RuntimeConfigRevision", "RuntimeConfigOverride"\s+CASCADE/);
    expect(setup.indexOf('TRUNCATE TABLE "RuntimeConfigRevision"')).toBeLessThan(setup.indexOf("await prisma.campus.deleteMany()"));
  });
  it("H-R3: browser never deletes revision evidence or its parent", () => {
    expect(browser).not.toMatch(/runtimeConfig(Revision|Override)\.deleteMany\(/);
    expect(browser).toContain("await context.close()");
  });
});
