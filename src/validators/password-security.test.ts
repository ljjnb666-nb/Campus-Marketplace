import { describe, expect, it } from "vitest";
import { newPasswordSchema } from "./auth";

describe("shared credential password policy", () => {
  it("rejects bcrypt-equivalent Unicode prefixes beyond its 72-byte boundary", () => {
    expect(newPasswordSchema.safeParse("GoodPass123" + "密".repeat(21)).success).toBe(false);
    expect(newPasswordSchema.safeParse("GoodPass123" + "密".repeat(20)).success).toBe(true);
  });
  it("enforces complexity and size for both registration and recovery", () => {
    for (const value of ["short1A", "alllowercase123", "ALLUPPERCASE123", "NoDigitsHere", "Aa1" + "x".repeat(62)]) {
      expect(newPasswordSchema.safeParse(value).success).toBe(false);
    }
    expect(newPasswordSchema.safeParse("A long Passphrase 123").success).toBe(true);
  });
});
