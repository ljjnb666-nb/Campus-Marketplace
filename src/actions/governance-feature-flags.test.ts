import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, setFeatureFlag, revalidatePath } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  setFeatureFlag: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/feature-flags/feature-flag-service", () => ({ setFeatureFlag }));
vi.mock("next/cache", () => ({ revalidatePath }));

import { changeGovernanceFeatureFlag } from "@/actions/governance-feature-flags";

const previous = { status: "idle", message: "" } as const;

function data(overrides: Record<string, string> = {}) {
  const form = new FormData();
  const defaults = {
    key: "DISABLE_NEW_ORDERS", campusId: "A", expectedVersion: "2",
    nextValue: "true", acknowledgement: "已确认影响范围",
  };
  for (const [key, value] of Object.entries({ ...defaults, ...overrides })) form.append(key, value);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "actor-from-session" });
  setFeatureFlag.mockResolvedValue({ key: "DISABLE_NEW_ORDERS", scopeKey: "CAMPUS:A", disabled: true, version: 3 });
});

describe("Phase 10G governance feature flag server action", () => {
  it("G04: only session-derived actor reaches canonical 10F writer", async () => {
    const result = await changeGovernanceFeatureFlag(previous, data());
    expect(result.status).toBe("success");
    expect(setFeatureFlag).toHaveBeenCalledWith({
      actorId: "actor-from-session", key: "DISABLE_NEW_ORDERS",
      campusId: "A", disabled: true, expectedVersion: 2,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/governance/feature-flags");
  });

  it("G05: injected actorId, duplicate fields and arbitrary flags reject before DB", async () => {
    const injected = data(); injected.append("actorId", "attacker");
    expect((await changeGovernanceFeatureFlag(previous, injected)).status).toBe("error");
    const duplicate = data(); duplicate.append("campusId", "B");
    expect((await changeGovernanceFeatureFlag(previous, duplicate)).status).toBe("error");
    expect((await changeGovernanceFeatureFlag(previous, data({ key: "SECRET_KEY" }))).status).toBe("error");
    expect(setFeatureFlag).not.toHaveBeenCalled();
    expect(requireUser).not.toHaveBeenCalled();
  });

  it("G06: invalid CAS and acknowledgement cannot mutate", async () => {
    expect((await changeGovernanceFeatureFlag(previous, data({ expectedVersion: "-1" }))).status).toBe("error");
    expect((await changeGovernanceFeatureFlag(previous, data({ expectedVersion: "9007199254740992" }))).status).toBe("error");
    expect((await changeGovernanceFeatureFlag(previous, data({ acknowledgement: "" }))).status).toBe("error");
    expect((await changeGovernanceFeatureFlag(previous, data({ nextValue: "inherit", expectedVersion: "0" }))).status).toBe("error");
    expect(setFeatureFlag).not.toHaveBeenCalled();
  });

  it("G07: GLOBAL and inherit are explicitly typed; no inherited row silently created", async () => {
    const result = await changeGovernanceFeatureFlag(previous, data({ campusId: "", nextValue: "inherit" }));
    expect(result.status).toBe("success");
    expect(setFeatureFlag).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "actor-from-session", campusId: null, disabled: null,
    }));
  });

  it("G08: version race is shown as actionable conflict with no secret leak", async () => {
    setFeatureFlag.mockRejectedValueOnce(new Error("FEATURE_FLAG_VERSION_CONFLICT"));
    const result = await changeGovernanceFeatureFlag(previous, data());
    expect(result.status).toBe("conflict");
    expect(result.message).toContain("刷新");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("G09: permission or storage errors fail closed, never expose internals", async () => {
    setFeatureFlag.mockRejectedValueOnce(new Error("postgres://secret"));
    const result = await changeGovernanceFeatureFlag(previous, data());
    expect(result.status).toBe("error");
    expect(result.message).not.toContain("postgres://");
  });
});
