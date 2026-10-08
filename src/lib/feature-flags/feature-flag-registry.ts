/**
 * Phase 10F. A flag is a restrictive server-side kill switch, never a permit.
 *
 * Global TRUE cannot be relaxed by a campus FALSE. NULL marks INHERIT.
 * Missing rows = no explicit disable, except when the authority DB is
 * unavailable/corrupt (fail-closed for all NEW_ACTIVITY operations).
 *
 * MAINTENANCE/READ_ONLY block new activity and public catalog edits, not safety/recovery,
 * cancellations, rental returns, dispute handling, privacy rights or ops.
 */
export const FEATURE_FLAG_KEYS = [
  "DISABLE_REGISTRATION",
  "DISABLE_NEW_LISTINGS",
  "DISABLE_NEW_ORDERS",
  "DISABLE_NEW_CONVERSATIONS",
  "DISABLE_NEW_MESSAGES",
  "DISABLE_MEETUPS",
  "DISABLE_DISPUTE_INITIATION",
  "MAINTENANCE_MODE",
  "READ_ONLY_MODE",
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

export const NEW_ACTIVITY_FLAG_KEYS = {
  REGISTRATION: ["DISABLE_REGISTRATION", "MAINTENANCE_MODE"],
  LISTING: ["DISABLE_NEW_LISTINGS", "MAINTENANCE_MODE", "READ_ONLY_MODE"],
  // Existing public content changes must not bypass emergency read-only.
  LISTING_EDIT: ["MAINTENANCE_MODE", "READ_ONLY_MODE"],
  ORDER: ["DISABLE_NEW_ORDERS", "MAINTENANCE_MODE", "READ_ONLY_MODE"],
  CONVERSATION: ["DISABLE_NEW_CONVERSATIONS", "MAINTENANCE_MODE", "READ_ONLY_MODE"],
  MESSAGE: ["DISABLE_NEW_MESSAGES", "MAINTENANCE_MODE", "READ_ONLY_MODE"],
  MEETUP: ["DISABLE_MEETUPS"],
  DISPUTE: ["DISABLE_DISPUTE_INITIATION"],
} as const satisfies Record<string, readonly FeatureFlagKey[]>;

export type NewActivityKind = keyof typeof NEW_ACTIVITY_FLAG_KEYS;

export function assertFeatureFlagKey(value: string): asserts value is FeatureFlagKey {
  if (!(FEATURE_FLAG_KEYS as readonly string[]).includes(value)) {
    throw new Error("FEATURE_FLAG_UNREGISTERED");
  }
}

export function assertFlagMutationValue(value: unknown): asserts value is boolean | null {
  if (value !== null && typeof value !== "boolean") {
    throw new Error("FEATURE_FLAG_VALUE_INVALID");
  }
}

/** Pure resolution: any GLOBAL or exact CAMPUS true disables; local false cannot override. */
export function isFlagDisabledForScope(
  rows: readonly { scopeKey: string; campusId: string | null; disabled: boolean | null }[],
  key: FeatureFlagKey,
  campusId: string,
): boolean {
  return rows.some((r) =>
    (r.scopeKey === "GLOBAL" && r.campusId === null && r.disabled === true) ||
    (r.scopeKey === `CAMPUS:${campusId}` && r.campusId === campusId && r.disabled === true),
  );
}
