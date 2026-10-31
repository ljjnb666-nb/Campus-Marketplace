// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { challengeToken, decryptMfa, digest, encryptMfa, equalDigest, matchTotpCounter, newTotpSecret, totpCode } from "./account-security-crypto";

const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
beforeEach(() => vi.stubEnv("NEXTAUTH_SECRET", "isolated-account-security-test-key-only"));
afterEach(() => vi.unstubAllEnvs());

describe("account security cryptography", () => {
  // Published independent SHA-1 vectors, RFC 6238 Appendix B.
  it.each([[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
    [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]])(
    "matches RFC 6238 at %i seconds", (seconds, expected) => {
      expect(totpCode(secret, Math.floor(Number(seconds) / 30), 8)).toBe(expected);
    });

  it("accepts only the bounded clock window and never a used or older counter", () => {
    const counter = 12345678; const now = counter * 30_000;
    for (const candidate of [counter - 1, counter, counter + 1]) {
      expect(matchTotpCounter(secret, totpCode(secret, candidate), null, now)).toBe(candidate);
      expect(matchTotpCounter(secret, totpCode(secret, candidate), BigInt(candidate), now)).toBeNull();
    }
    expect(matchTotpCounter(secret, totpCode(secret, counter - 2), null, now)).toBeNull();
    expect(matchTotpCounter(secret, totpCode(secret, counter + 2), null, now)).toBeNull();
    for (const malformed of ["12345", "1234567", "12345a", " 123456", "１２３４５６"]) {
      expect(matchTotpCounter(secret, malformed, null, now)).toBeNull();
    }
  });

  it("encrypts setup secrets with randomized authenticated owner binding", () => {
    const encrypted = encryptMfa(secret, "owner-a");
    expect(encrypted).not.toContain(secret);
    expect(encryptMfa(secret, "owner-a")).not.toBe(encrypted);
    expect(decryptMfa(encrypted, "owner-a")).toBe(secret);
    expect(() => decryptMfa(encrypted, "owner-b")).toThrow();
    const damaged = Buffer.from(encrypted, "base64url"); damaged[damaged.length - 1] ^= 1;
    expect(() => decryptMfa(damaged.toString("base64url"), "owner-a")).toThrow();
    vi.stubEnv("NEXTAUTH_SECRET", "different-isolated-account-security-key");
    expect(() => decryptMfa(encrypted, "owner-a")).toThrow();
  });

  it("binds retry-stable challenge tokens to their purpose and unique id", () => {
    const token = challengeToken("challenge-a", "VERIFY_EMAIL");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challengeToken("challenge-a", "VERIFY_EMAIL")).toBe(token);
    expect(challengeToken("challenge-a", "RESET_PASSWORD")).not.toBe(token);
    expect(challengeToken("challenge-b", "VERIFY_EMAIL")).not.toBe(token);
    expect(equalDigest(digest(token), digest(token))).toBe(true);
    expect(equalDigest(digest(token), digest("other"))).toBe(false);
    expect(equalDigest(digest(token), "short")).toBe(false);
    vi.stubEnv("NEXTAUTH_SECRET", "");
    expect(() => challengeToken("challenge-a", "VERIFY_EMAIL")).toThrow("ACCOUNT_SECURITY_KEY_UNAVAILABLE");
  });

  it("generates 160-bit authenticator keys", () => {
    const keys = Array.from({ length: 16 }, () => newTotpSecret());
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[A-Z2-7]{32}$/);
  });
});
