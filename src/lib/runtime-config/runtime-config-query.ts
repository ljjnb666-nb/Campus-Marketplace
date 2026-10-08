import { prisma } from "@/lib/prisma";
import {
  assertRuntimeConfigKey,
  parseRuntimeConfigValue,
  RUNTIME_CONFIG_REGISTRY,
  type RuntimeConfigKey,
} from "@/lib/runtime-config/runtime-config-registry";

export type EffectiveRuntimeConfig = {
  key: RuntimeConfigKey;
  value: number;
  source: "CAMPUS_OVERRIDE" | "GLOBAL_OVERRIDE" | "DEFAULT" | "SAFE_FALLBACK";
  version: number | null;
};

/**
 * Single-query scoped precedence: CAMPUS > GLOBAL > typed default.
 * No process-memory cache: cross-instance edits visible on the next read.
 * Invalid selected override or DB failure fails to stricter SAFE_FALLBACK,
 * never to a stale/less restrictive value or an unrelated campus.
 */
export async function loadEffectiveRuntimeConfig(input: {
  key: RuntimeConfigKey;
  campusId?: string;
}): Promise<EffectiveRuntimeConfig> {
  assertRuntimeConfigKey(input.key);
  if (input.campusId !== undefined && !input.campusId.trim()) {
    throw new Error("RUNTIME_CONFIG_SCOPE_INVALID");
  }
  const def = RUNTIME_CONFIG_REGISTRY[input.key];
  const scopeKeys = input.campusId
    ? ["GLOBAL", `CAMPUS:${input.campusId}`]
    : ["GLOBAL"];

  try {
    const rows = await prisma.runtimeConfigOverride.findMany({
      where: { key: input.key, scopeKey: { in: scopeKeys } },
      select: { scopeKey: true, campusId: true, value: true, version: true },
    });
    const campus = input.campusId
      ? rows.find((row) => row.scopeKey === `CAMPUS:${input.campusId}`)
      : undefined;
    const global = rows.find((row) => row.scopeKey === "GLOBAL");
    const selected = campus ?? global;
    if (!selected) {
      return { key: input.key, value: def.defaultValue, source: "DEFAULT", version: null };
    }
    // Validate DB truth; do NOT hide malformed CAMPUS override by using GLOBAL.
    if (
      (selected.scopeKey === "GLOBAL" && selected.campusId !== null) ||
      (selected.scopeKey !== "GLOBAL" &&
        selected.scopeKey !== `CAMPUS:${selected.campusId}`) ||
      !Number.isSafeInteger(selected.version) ||
      selected.version < 1
    ) {
      throw new Error("RUNTIME_CONFIG_ROW_CORRUPT");
    }
    const value = parseRuntimeConfigValue(input.key, selected.value);
    return {
      key: input.key,
      value,
      source: campus ? "CAMPUS_OVERRIDE" : "GLOBAL_OVERRIDE",
      version: selected.version,
    };
  } catch {
    // Fail-safe constant is independent of DB and cannot exceed hard maximum.
    return {
      key: input.key,
      value: def.safeFallbackValue,
      source: "SAFE_FALLBACK",
      version: null,
    };
  }
}
