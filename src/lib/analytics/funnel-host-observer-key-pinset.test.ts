import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareCandidateObserverPinCatalog,
  type ObserverKeyPinCandidate,
} from "@/lib/analytics/funnel-host-observer-key-pinset";
import {
  hostObserverSigningBytes,
  verifyCandidateHostObserverSignature,
} from "@/lib/analytics/funnel-host-observer-signature";

const NOW = new Date("2026-10-10T06:00:00.000Z");
const key = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const canonicalPem = (publicKey: typeof key.publicKey) =>
  publicKey.export({ type: "spki", format: "pem" }).toString();
const fingerprint = (publicKey: typeof key.publicKey) =>
  createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" })).digest("hex");

function candidate(
  changes: Partial<ObserverKeyPinCandidate> = {},
  signer = key,
): ObserverKeyPinCandidate {
  return {
    principalId: "observer.01",
    hostId: "host.01",
    keyId: "key.01",
    publicKeyPem: canonicalPem(signer.publicKey),
    spkiSha256: fingerprint(signer.publicKey),
    validFrom: new Date(NOW.getTime() - 86_400_000),
    validUntil: new Date(NOW.getTime() + 86_400_000),
    revoked: false,
    ...changes,
  };
}
const check = (rows: unknown) => prepareCandidateObserverPinCatalog(rows);
const denied = "DENIED_INVALID_CANDIDATE_PINSET";

afterEach(() => vi.useRealTimers());

describe("10K-R2d-03B-02B-02B-02 candidate pin catalog", () => {
  it("accepts canonical Ed25519 SPKI + SHA-256 but grants no independent authority", () => {
    const result = check([candidate()]);
    expect(result.status).toBe("CANDIDATE_PINSET_CONSISTENT_ONLY");
    expect(result.pinCount).toBe(1);
    expect(result.getCandidateKey("key.01")?.publicKeyPem).toBe(canonicalPem(key.publicKey));
    expect(result.getCandidateKey("missing")).toBeUndefined();
    expect(result.independentProvisioningVerified).toBe(false);
    expect(result.independentHostAuthenticated).toBe(false);
    expect(result.deploymentMembershipComplete).toBe(false);
    expect(result.captureContinuityProven).toBe(false);
    expect(result.canPublish).toBe(false);
  });

  it("supports distinct rotation keys on the same principal + host", () => {
    const output = check([
      candidate(),
      candidate({ keyId: "key.02" }, other),
    ]);
    expect(output.status).toBe("CANDIDATE_PINSET_CONSISTENT_ONLY");
    expect(output.pinCount).toBe(2);
  });

  it("supports two principals on one host without confusing their key identities", () => {
    const output = check([
      candidate(),
      candidate({ principalId: "observer.02", keyId: "key.02" }, other),
    ]);
    expect(output.status).toBe("CANDIDATE_PINSET_CONSISTENT_ONLY");
    expect(output.getCandidateKey("key.02")?.principalId).toBe("observer.02");
    expect(output.getCandidateKey("key.01")?.principalId).toBe("observer.01");
  });

  it("rejects reused key IDs, including across different principals or hosts", () => {
    const output = check([
      candidate(),
      candidate({ principalId: "observer.02", hostId: "host.02" }, other),
    ]);
    expect(output.status).toBe(denied);
    expect(output.getCandidateKey("key.01")).toBeUndefined();
  });

  it("rejects reused SPKI key material even under distinct key IDs", () => {
    expect(check([
      candidate(),
      candidate({ keyId: "key.02", principalId: "observer.02", hostId: "host.02" }),
    ]).status).toBe(denied);
  });

  it("rejects one principal attached to two different hosts", () => {
    expect(check([
      candidate(),
      candidate({ hostId: "host.02", keyId: "key.02" }, other),
    ]).status).toBe(denied);
  });

  it("rejects a forged or malformed fingerprint", () => {
    expect(check([candidate({ spkiSha256: "a".repeat(64) })]).status).toBe(denied);
    expect(check([candidate({ spkiSha256: "A".repeat(64) })]).status).toBe(denied);
    expect(check([candidate({ spkiSha256: "hello" })]).status).toBe(denied);
  });

  it("rejects noncanonical, private-key, oversized, and malformed PEM", () => {
    const privatePem = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(check([candidate({ publicKeyPem: privatePem })]).status).toBe(denied);
    expect(check([candidate({ publicKeyPem: canonicalPem(key.publicKey) + "garbage" })]).status).toBe(denied);
    expect(check([candidate({ publicKeyPem: "x".repeat(2049) })]).status).toBe(denied);
    expect(check([candidate({ publicKeyPem: "not-a-key" })]).status).toBe(denied);
  });

  it("rejects RSA and any public key other than Ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(check([candidate({
      publicKeyPem: canonicalPem(rsa.publicKey),
      spkiSha256: fingerprint(rsa.publicKey),
    })]).status).toBe(denied);
  });

  it("does not accept extra secret, user, metadata, symbol or accessor fields", () => {
    const extra = { ...candidate(), accessKey: "secret-never-persist" };
    const symbol = { ...candidate(), [Symbol("hidden")]: "secret" };
    const getter = { ...candidate() };
    Object.defineProperty(getter, "hostId", {
      enumerable: true,
      get: () => "host.01",
    });
    for (const value of [extra, symbol, getter]) {
      const result = check([value]);
      expect(result.status).toBe(denied);
      expect(result.canPublish).toBe(false);
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });

  it("rejects malformed principals, host scopes and key IDs", () => {
    for (const row of [
      candidate({ principalId: "../admin" }),
      candidate({ hostId: "" }),
      candidate({ keyId: "bad key" }),
      candidate({ principalId: "p".repeat(129) }),
      candidate({ revoked: undefined as unknown as boolean }),
    ]) expect(check([row]).status).toBe(denied);
  });

  it("enforces finite ascending epoch times without silent expiry extensions", () => {
    for (const row of [
      candidate({ validFrom: new Date("invalid") }),
      candidate({ validUntil: new Date("invalid") }),
      candidate({ validFrom: new Date(NOW), validUntil: new Date(NOW) }),
      candidate({ validFrom: new Date(NOW.getTime() + 1), validUntil: NOW }),
      candidate({ validFrom: new Date(-1) }),
    ]) expect(check([row]).status).toBe(denied);
  });

  it("preserves revoked epochs for the downstream fail-closed verifier", () => {
    const output = check([candidate({ revoked: true })]);
    expect(output.getCandidateKey("key.01")?.revoked).toBe(true);
    expect(output.independentHostAuthenticated).toBe(false);
  });

  it("returns fresh Date objects and cannot be mutated by caller after creation", () => {
    const input = candidate();
    const catalog = check([input]);
    input.validFrom.setTime(0);
    const first = catalog.getCandidateKey("key.01");
    expect(first?.validFrom.getTime()).toBe(NOW.getTime() - 86_400_000);
    first!.validFrom.setTime(0);
    expect(catalog.getCandidateKey("key.01")?.validFrom.getTime())
      .toBe(NOW.getTime() - 86_400_000);
  });

  it("rejects empty, over-budget, nonarray or throwing proxy inputs", () => {
    expect(check([]).status).toBe(denied);
    expect(check(Array.from({ length: 129 }, () => candidate())).status).toBe(denied);
    expect(check(null).status).toBe(denied);
    const throwing = new Proxy(candidate(), {
      ownKeys: () => { throw new Error("private-key-hidden"); },
    });
    const response = check([throwing]);
    expect(response.status).toBe(denied);
    expect(JSON.stringify(response)).not.toContain("private-key-hidden");
  });

  it("can supply a candidate verifier key but never promote cryptographic match to auth", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const catalog = check([candidate()]);
    const observerKey = catalog.getCandidateKey("key.01");
    expect(observerKey).toBeDefined();
    const body = {
      principalId: "observer.01",
      keyId: "key.01",
      signedAt: NOW,
      observation: {
        origin: "UNVERIFIED_HOST_OBSERVER" as const,
        hostId: "host.01",
        sessionId: "boot.01",
        sequence: 1,
        observedAt: new Date(NOW.getTime() - 1_000),
        kind: "HEARTBEAT" as const,
      },
    };
    const signatureBase64url = sign(null, hostObserverSigningBytes(body), key.privateKey)
      .toString("base64url");
    const result = verifyCandidateHostObserverSignature(
      { ...body, signatureBase64url },
      new Map([["key.01", observerKey!]]),
    );
    expect(result.reason).toBe("CANDIDATE_SIGNATURE_MATCH_ONLY");
    expect(result.cryptographicSignatureMatches).toBe(true);
    expect(result.independentHostAuthenticated).toBe(false);
    expect(result.canPublish).toBe(false);
  });
});
