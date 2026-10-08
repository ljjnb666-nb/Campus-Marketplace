import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const setup = readFileSync("scripts/e2e-setup.ts", "utf8");
const spec = readFileSync("tests/e2e/phase10g-feature-flags.spec.ts", "utf8");

describe("Phase 10G immutable E2E fixture isolation contract", () => {
  it("R1: production-safety guard is always called before test database reset", () => {
    const main = setup.slice(setup.indexOf("async function main()"));
    expect(main.indexOf("assertE2EDatabaseIsolation(")).toBeGreaterThanOrEqual(0);
    expect(main.indexOf("assertE2EDatabaseIsolation(")).toBeLessThan(main.indexOf("wipeAll(prisma)"));
  });

  it("R2: scoped append-only tables reset without CASCADE and before Campus reset", () => {
    expect(setup).toContain('TRUNCATE TABLE "FeatureFlagRevision", "FeatureFlagOverride"');
    expect(setup).not.toMatch(/TRUNCATE TABLE "FeatureFlagRevision", "FeatureFlagOverride"\s+CASCADE/);
    expect(setup.indexOf('TRUNCATE TABLE "FeatureFlagRevision"')).toBeLessThan(
      setup.indexOf("await prisma.campus.deleteMany()"),
    );
  });

  it("R3: browser E2E does not delete immutable revisions or their parent override", () => {
    expect(spec).not.toMatch(/featureFlagRevision\.deleteMany\(/);
    expect(spec).not.toMatch(/featureFlagOverride\.deleteMany\(/);
    expect(spec).toContain("await context.close()");
  });
});
