import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { consumeCredentialLoginBudget, finishCredentialLoginBudget, LOGIN_SOURCE_LIMIT, resolveAuthClientSource } from "./login-rate-limit";

describe("source and account login budgets", () => {
  it("an attacker's failed attempts do not lock the victim at another source", async () => {
    const email = `${randomUUID()}@example.invalid`;
    for (let i = 0; i < 10; i++) expect((await consumeCredentialLoginBudget(email, { "x-real-ip": "203.0.113.31" })).limited).toBe(false);
    expect((await consumeCredentialLoginBudget(email, { "x-real-ip": "203.0.113.31" })).limited).toBe(true);
    expect((await consumeCredentialLoginBudget(email, { "x-real-ip": "203.0.113.32" })).limited).toBe(false);
  });
  it("rotating emails and successful owned logins cannot reset the source budget", async () => {
    const source = { "x-real-ip": "203.0.113.33" };
    for (let i = 0; i < LOGIN_SOURCE_LIMIT; i++) {
      const attempt = await consumeCredentialLoginBudget(`${randomUUID()}@example.invalid`, source);
      expect(attempt.limited).toBe(false);
      await finishCredentialLoginBudget(attempt.accountSourceKey);
    }
    expect((await consumeCredentialLoginBudget(`${randomUUID()}@example.invalid`, source)).limited).toBe(true);
  });
  it("uses the proxy-overwritten source and never creates buckets from invalid unbounded headers", () => {
    expect(resolveAuthClientSource({ "x-real-ip": "203.0.113.35", "x-forwarded-for": "spoofed" })).toBe("203.0.113.35");
    expect(resolveAuthClientSource({ "x-real-ip": "invalid" })).toBe("unknown");
  });
});
