import { describe, expect, it } from "vitest";
import {
  HostLifecycleClaimContractError,
  prepareUnverifiedHostLifecycleClaim,
} from "@/lib/analytics/funnel-host-lifecycle-claim-journal";
import type { UnverifiedHostLifecycleObservation as Observation } from
  "@/lib/analytics/funnel-host-lifecycle-replay";

const app = { instanceId: "app.01", releaseSha: "a".repeat(40), role: "APP" as const };
const worker = { instanceId: "worker.01", releaseSha: "b".repeat(40),
  role: "ASYNC_WORKER" as const };
const baseline = (): Observation => ({
  origin: "UNVERIFIED_HOST_OBSERVER", hostId: "host.01",
  sessionId: "boot.01", sequence: 1,
  observedAt: new Date("2026-10-01T00:00:00Z"), kind: "BASELINE",
  instances: [app, worker],
});

const prepare = (value: Observation) => prepareUnverifiedHostLifecycleClaim(value);
const fails = (input: Observation) =>
  expect(() => prepare(input)).toThrow(HostLifecycleClaimContractError);

describe("10K-R2d-03B-02B-02A unverified host observation journal input contract", () => {
  it("only emits machine allowlisted fields with unverified provenance", () => {
    const record = prepare(baseline());
    expect(record).toMatchObject({
      hostId: "host.01", sessionId: "boot.01", sequence: 1n,
      kind: "BASELINE", instanceId: null, releaseSha: null, role: null,
      source: "UNVERIFIED",
    });
    expect(record.claimKey).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(record.baselineJson!)).toEqual([app, worker]);
    expect(record).not.toHaveProperty("recordedAt");
  });

  it("order-independent, idempotent canonical baseline member identity", () => {
    const a = prepare(baseline());
    const b = prepare({ ...baseline(), instances: [worker, app] });
    expect(b.claimKey).toBe(a.claimKey);
    expect(b.baselineJson).toBe(a.baselineJson);
  });

  it("strips arbitrary object fields from baseline machine rows", () => {
    const entry = {
      ...app, userId: "secret-user", ip: "10.0.0.2",
      environment: { KEY: "raw-secret" }, arbitrary: "PII",
    };
    const record = prepare({ ...baseline(), instances: [entry, worker] });
    expect(record.baselineJson).not.toContain("secret-user");
    expect(record.baselineJson).not.toContain("10.0.0.2");
    expect(record.baselineJson).not.toContain("raw-secret");
    expect(JSON.parse(record.baselineJson!)).toEqual([app, worker]);
  });

  it("rejects duplicate, invalid and oversized candidate fleets", () => {
    fails({ ...baseline(), instances: [app, app] });
    fails({ ...baseline(), instances: Array(129).fill(app) });
    fails({ ...baseline(), instances: [null as never] });
    fails({ ...baseline(), instances: [{ ...app, releaseSha: new String(app.releaseSha) as unknown as string }] });
    fails({ ...baseline(), instances: [{ ...app, instanceId: "../escape" }] });
  });

  it("requires exact kind-specific payload shape and never accepts a producer-attested source", () => {
    fails({ ...baseline(), origin: "TRUSTED_HOST_OBSERVER" as never });
    fails({ ...baseline(), instance: app });
    fails({ ...baseline(), instances: undefined });
    fails({ ...baseline(), kind: "START" });
    fails({ ...baseline(), kind: "STOP", instance: app });
    fails({ ...baseline(), kind: "HEARTBEAT", instance: app });
    fails({ ...baseline(), kind: "DISCONNECTED", instances: [] });
  });

  it("sanitizes START/STOP and forbids baseline payload on them", () => {
    const event: Observation = {
      ...baseline(), kind: "START", instances: undefined,
      instance: { ...app, userId: "ignored" } as typeof app,
    };
    const a = prepare(event);
    const b = prepare({ ...event, kind: "STOP" });
    expect(a).toMatchObject({
      instanceId: app.instanceId, role: "APP",
      releaseSha: app.releaseSha, baselineJson: null, source: "UNVERIFIED",
    });
    expect(a.claimKey).not.toBe(b.claimKey);
    expect(JSON.stringify(a)).not.toContain("ignored");
    fails({ ...event, instances: [] });
  });

  it("accepts only bounded safe sequence numbers and timestamp identities", () => {
    for (const sequence of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1,
      NaN, Infinity]) {
      fails({ ...baseline(), sequence });
    }
    fails({ ...baseline(), observedAt: new Date("invalid") });
    fails({ ...baseline(), observedAt: new Date("1969-12-31T23:59:59Z") });
    fails({ ...baseline(), hostId: "../bad" });
    fails({ ...baseline(), sessionId: "" });
  });

  it("different same-sequence payloads have different keys and must be rejected by DB unique constraint", () => {
    const x = prepare(baseline());
    const y = prepare({ ...baseline(), instances: [app] });
    expect(x.claimKey).not.toBe(y.claimKey);
    expect(x.hostId).toBe(y.hostId);
    expect(x.sessionId).toBe(y.sessionId);
    expect(x.sequence).toBe(y.sequence);
  });

  it("refuses an unauthorized kind or extra machine payload", () => {
    fails({ ...baseline(), kind: "ATTESTED" as never });
    fails({ ...baseline(), kind: "HEARTBEAT", instances: undefined, instance: app });
    expect(prepare({ ...baseline(), kind: "HEARTBEAT", instances: undefined })).toMatchObject({
      role: null, baselineJson: null, source: "UNVERIFIED",
    });
  });
});
