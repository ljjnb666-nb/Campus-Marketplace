/**
 * Phase 10E registered, non-secret runtime configuration.
 * Frozen registry is the only valid source of write and read keys.
 * NO provider credentials, authentication state, payout/settlement, policy
 * versions, account permissions, kill switches or feature flags.
 */
export const RUNTIME_CONFIG_REGISTRY = {
  RISK_SIGNAL_EVIDENCE_LIMIT: {
    type: "INTEGER",
    min: 5,
    max: 50,
    defaultValue: 50,
    // Fail safer than default when config authority cannot be read.
    safeFallbackValue: 10,
  },
} as const;

export type RuntimeConfigKey = keyof typeof RUNTIME_CONFIG_REGISTRY;

export function parseRuntimeConfigValue(key: string, value: unknown): number {
  const def = Object.prototype.hasOwnProperty.call(RUNTIME_CONFIG_REGISTRY, key)
    ? RUNTIME_CONFIG_REGISTRY[key as RuntimeConfigKey]
    : null;
  if (
    !def ||
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < def.min ||
    value > def.max
  ) {
    throw new Error("RUNTIME_CONFIG_VALUE_INVALID");
  }
  return value;
}

export function assertRuntimeConfigKey(key: string): asserts key is RuntimeConfigKey {
  if (!Object.prototype.hasOwnProperty.call(RUNTIME_CONFIG_REGISTRY, key)) {
    throw new Error("RUNTIME_CONFIG_KEY_NOT_REGISTERED");
  }
}
