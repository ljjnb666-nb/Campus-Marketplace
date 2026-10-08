import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, setRuntimeConfig, revalidatePath } = vi.hoisted(() => ({
  requireUser: vi.fn(), setRuntimeConfig: vi.fn(), revalidatePath: vi.fn(),
}));
vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/runtime-config/runtime-config-service", () => ({ setRuntimeConfig }));
vi.mock("next/cache", () => ({ revalidatePath }));

import { changeGovernanceRuntimeConfig } from "@/actions/governance-runtime-config";

const previous = { status: "idle", message: "" } as const;
function data(overrides: Record<string, string> = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    key: "RISK_SIGNAL_EVIDENCE_LIMIT", campusId: "A", expectedVersion: "2",
    nextValue: "12", acknowledgement: "已确认配置影响", ...overrides,
  })) form.append(key, value);
  return form;
}
beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "real-session-actor" });
  setRuntimeConfig.mockResolvedValue({ version: 3 });
});

describe("10H runtime config action", () => {
  it("uses session actor, bounded numeric value and canonical CAS writer", async () => {
    expect((await changeGovernanceRuntimeConfig(previous, data())).status).toBe("success");
    expect(setRuntimeConfig).toHaveBeenCalledWith({
      actorId: "real-session-actor", key: "RISK_SIGNAL_EVIDENCE_LIMIT",
      campusId: "A", value: 12, expectedVersion: 2,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/governance/runtime-config");
  });

  it("ignores only reserved Next.js $ACTION_* transport fields, never business injections", async () => {
    const form = data();
    form.append("$ACTION_KEY", "framework-generated");
    form.append("$ACTION_REF_0", "framework-generated");
    expect((await changeGovernanceRuntimeConfig(previous, form)).status).toBe("success");
    expect(setRuntimeConfig).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "real-session-actor", campusId: "A", value: 12,
    }));
    const tampered = data();
    tampered.append("actorId", "attacker");
    tampered.append("$ACTION_KEY", "framework-generated");
    expect((await changeGovernanceRuntimeConfig(previous, tampered)).status).toBe("error");
    expect(setRuntimeConfig).toHaveBeenCalledTimes(1);
  });

  it("GLOBAL is explicit; inherit is a null tombstone with its own CAS version", async () => {
    expect((await changeGovernanceRuntimeConfig(previous, data({ campusId: "", nextValue: "inherit" }))).status)
      .toBe("success");
    expect(setRuntimeConfig).toHaveBeenCalledWith(expect.objectContaining({ campusId: null, value: null }));
  });

  it("rejects arbitrary keys, injected identity, duplicate fields and files before auth", async () => {
    const injected = data(); injected.append("actorId", "attacker");
    const duplicate = data(); duplicate.append("campusId", "B");
    const file = data(); file.append("random", new File(["x"], "x.txt"));
    for (const form of [injected, duplicate, file, data({ key: "SECRET_KEY" })]) {
      expect((await changeGovernanceRuntimeConfig(previous, form)).status).toBe("error");
    }
    expect(requireUser).not.toHaveBeenCalled();
    expect(setRuntimeConfig).not.toHaveBeenCalled();
  });

  it("rejects invalid value/version and empty inheritance without DB mutations", async () => {
    const invalidCases: Record<string, string>[] = [
      { nextValue: "4" }, { nextValue: "51" }, { nextValue: "1.5" },
      { nextValue: "05" }, { nextValue: "" },
      { expectedVersion: "-1" }, { expectedVersion: "9007199254740992" },
      { acknowledgement: "" }, { nextValue: "inherit", expectedVersion: "0" },
    ];
    for (const overrides of invalidCases) {
      expect((await changeGovernanceRuntimeConfig(previous, data(overrides))).status).toBe("error");
    }
    expect(setRuntimeConfig).not.toHaveBeenCalled();
  });

  it("maps races to refresh and never leaks DB details", async () => {
    setRuntimeConfig.mockRejectedValueOnce(new Error("RUNTIME_CONFIG_VERSION_CONFLICT"));
    const conflict = await changeGovernanceRuntimeConfig(previous, data());
    expect(conflict.status).toBe("conflict");
    expect(conflict.message).toContain("刷新");
    setRuntimeConfig.mockRejectedValueOnce(new Error("postgres://private-connection-string"));
    const error = await changeGovernanceRuntimeConfig(previous, data());
    expect(error.status).toBe("error");
    expect(error.message).not.toContain("postgres://");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
