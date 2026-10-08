/**
 * Phase 10K-R1: frozen REQUIREMENTS for analytics that are NOT instrumented.
 *
 * This registry intentionally does NOT register DomainEvents or emit
 * MetricContributions. R2/R3 must supply facts and acceptance proof before
 * any value is exposed; downstream UI must never infer zero from absence.
 */
export type MeasurementGap =
  | "SEARCH_ZERO_RESULT_RATE"
  | "LISTING_TO_CONVERSATION_RATE"
  | "CONVERSATION_TO_ORDER_RATE"
  | "TIME_TO_FIRST_INTERACTION"
  | "SUPPLY_DEMAND_GAP"
  | "PILOT_NORTH_STAR";

export type MeasurementContract = Readonly<{
  key: MeasurementGap;
  version: 1;
  status: "UNAVAILABLE_PENDING_INSTRUMENTATION";
  authority: "AGGREGATED_REQUEST_TELEMETRY" | "CANONICAL_DOMAIN_FACTS" | "PRODUCT_DECISION_PENDING";
  scope: "GLOBAL_ONLY" | "EXACT_CAMPUS";
  unit: "RATE" | "DURATION_SECONDS" | "COUNT_GAP" | "COUNT";
  numerator: string | null;
  denominator: string | null;
  unavailableReason: string;
}>;

export const PHASE_10K_PENDING_MEASUREMENTS: readonly MeasurementContract[] = [
  {
    key: "SEARCH_ZERO_RESULT_RATE",
    version: 1,
    status: "UNAVAILABLE_PENDING_INSTRUMENTATION",
    authority: "AGGREGATED_REQUEST_TELEMETRY",
    scope: "GLOBAL_ONLY",
    unit: "RATE",
    numerator: "valid all-zero search requests during window",
    denominator: "all valid eligible search requests during same window",
    unavailableReason: "No privacy-reviewed, server-owned completed-search telemetry exists",
  },
  {
    key: "LISTING_TO_CONVERSATION_RATE",
    version: 1,
    status: "UNAVAILABLE_PENDING_INSTRUMENTATION",
    authority: "CANONICAL_DOMAIN_FACTS",
    scope: "EXACT_CAMPUS",
    unit: "RATE",
    numerator: "eligible listing cohort IDs with first attributable conversation within 7d",
    denominator: "eligible unique new listing IDs in same mature cohort",
    unavailableReason: "No verified listing-conversation attribution and cohort completeness proof",
  },
  {
    key: "CONVERSATION_TO_ORDER_RATE",
    version: 1,
    status: "UNAVAILABLE_PENDING_INSTRUMENTATION",
    authority: "CANONICAL_DOMAIN_FACTS",
    scope: "EXACT_CAMPUS",
    unit: "RATE",
    numerator: "eligible conversation cohort IDs with first attributable order within 7d",
    denominator: "eligible unique conversation IDs in same mature cohort",
    unavailableReason: "Existing order-first conversations cannot be assumed to be pre-order conversions",
  },
  {
    key: "TIME_TO_FIRST_INTERACTION",
    version: 1,
    status: "UNAVAILABLE_PENDING_INSTRUMENTATION",
    authority: "CANONICAL_DOMAIN_FACTS",
    scope: "EXACT_CAMPUS",
    unit: "DURATION_SECONDS",
    numerator: "verified first qualifying participant reply timestamp minus conversation createdAt",
    denominator: null,
    unavailableReason: "No verified first-interaction semantics/coverage across canonical message kinds",
  },
  {
    key: "SUPPLY_DEMAND_GAP",
    version: 1,
    status: "UNAVAILABLE_PENDING_INSTRUMENTATION",
    authority: "CANONICAL_DOMAIN_FACTS",
    scope: "EXACT_CAMPUS",
    unit: "COUNT_GAP",
    numerator: "open eligible demand units minus contemporaneous matching supply capacity",
    denominator: null,
    unavailableReason: "Category and unit compatibility/capacity are not yet normalized across domains",
  },
  {
    key: "PILOT_NORTH_STAR",
    version: 1,
    status: "UNAVAILABLE_PENDING_INSTRUMENTATION",
    authority: "PRODUCT_DECISION_PENDING",
    scope: "EXACT_CAMPUS",
    unit: "COUNT",
    numerator: null,
    denominator: null,
    unavailableReason: "Pilot north-star definition and acceptance threshold not yet product-approved",
  },
] as const;

export type MeasurementRateResult =
  | Readonly<{ available: false; reason: "NO_ELIGIBLE_COHORT" | "MISSING_AUTHORITY" | "COUNT_INVARIANT_FAILED" }>
  | Readonly<{ available: true; numerator: number; denominator: number; percent: string }>;

/**
 * Pure presenter for an ALREADY AUTHORIZED, COMPLETE cohort.
 * No DB or metric rows are read here. Returning unavailable is deliberate;
 * 0% is valid only with a proven nonzero denominator and zero numerator.
 */
export function presentVerifiedRate(input: {
  numerator: number | null;
  denominator: number | null;
  authorityComplete: boolean;
}): MeasurementRateResult {
  if (!input.authorityComplete || input.numerator === null || input.denominator === null) {
    return { available: false, reason: "MISSING_AUTHORITY" };
  }
  const { numerator, denominator } = input;
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator < 0 || denominator < 0 ||
    numerator > denominator
  ) {
    return { available: false, reason: "COUNT_INVARIANT_FAILED" };
  }
  if (denominator === 0) {
    return { available: false, reason: "NO_ELIGIBLE_COHORT" };
  }
  return {
    available: true,
    numerator,
    denominator,
    percent: (100 * numerator / denominator).toFixed(2),
  };
}
