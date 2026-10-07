import type {
  Prisma,
  RiskFlagKind,
  RiskFlagSeverity,
} from "@prisma/client";

import type { RiskReadAccess } from "@/lib/risk/risk-read-access";
import { prisma } from "@/lib/prisma";

/**
 * Phase 10D — Risk Intelligence v1.
 *
 * HARD BOUNDARIES:
 * - RiskFlag = source-linked signal input, never a punishment verdict.
 * - Risk Intelligence = deterministic advisory read model, never RiskState authority.
 * - RiskState remains the explicit governance-operated restriction state.
 * - EnforcementAction remains the immutable punishment provenance.
 * - NO_OPAQUE_SCORING: there is no numeric risk/trust score.
 * - REPORT_SUBMITTED and dispute context can never auto-escalate into punishment.
 */
export const RISK_RULESET_VERSION = 1;
export const RISK_SIGNAL_EVIDENCE_LIMIT = 50;

export type RiskAttentionLevel =
  | "CLEAR"
  | "OBSERVE"
  | "REVIEW"
  | "PRIORITY_REVIEW";

export type RiskRecommendedAction =
  | "NONE"
  | "MONITOR"
  | "OPERATOR_REVIEW"
  | "PRIORITY_OPERATOR_REVIEW";

export type RiskRuleId =
  | "MANUAL_HIGH_SIGNAL"
  | "CONFIRMED_HIGH_SIGNAL"
  | "CONFIRMED_REPORT_PRESENT"
  | "MANUAL_REVIEW_SIGNAL"
  | "UNCONFIRMED_REPORT_CONTEXT"
  | "DISPUTE_CONTEXT_ONLY";

export type RiskSignalBucket = {
  kind: RiskFlagKind;
  severity: RiskFlagSeverity;
  count: number;
};

export type RiskSignalEvidence = {
  signalId: string;
  kind: RiskFlagKind;
  severity: RiskFlagSeverity;
  campusId: string | null;
  sourceType: string;
  createdAt: string;
};

export type RiskMatchedRule = {
  ruleId: RiskRuleId;
  signalCount: number;
};

export type RiskEvaluationScope =
  | { kind: "ALL_SCOPES" }
  | { kind: "CAMPUS"; campusId: string };

export type RiskIntelligenceAssessment = {
  targetUserId: string;
  rulesetVersion: number;
  evaluatedAt: string;
  scope: RiskEvaluationScope;
  attentionLevel: RiskAttentionLevel;
  recommendedAction: RiskRecommendedAction;
  matchedRules: RiskMatchedRule[];
  activeSignalCount: number;
  signalBreakdown: RiskSignalBucket[];
  evidence: RiskSignalEvidence[];
  evidenceTruncated: boolean;
};

const ATTENTION_RANK: Record<RiskAttentionLevel, number> = {
  CLEAR: 0,
  OBSERVE: 1,
  REVIEW: 2,
  PRIORITY_REVIEW: 3,
};

const SEVERITY_RANK: Record<RiskFlagSeverity, number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

function maxAttention(
  left: RiskAttentionLevel,
  right: RiskAttentionLevel,
): RiskAttentionLevel {
  return ATTENTION_RANK[right] > ATTENTION_RANK[left] ? right : left;
}

function countSignals(
  buckets: RiskSignalBucket[],
  predicate: (bucket: RiskSignalBucket) => boolean,
): number {
  return buckets.reduce(
    (sum, bucket) => sum + (predicate(bucket) ? bucket.count : 0),
    0,
  );
}

function recommendationFor(level: RiskAttentionLevel): RiskRecommendedAction {
  switch (level) {
    case "PRIORITY_REVIEW":
      return "PRIORITY_OPERATOR_REVIEW";
    case "REVIEW":
      return "OPERATOR_REVIEW";
    case "OBSERVE":
      return "MONITOR";
    default:
      return "NONE";
  }
}

function normalizeBuckets(buckets: RiskSignalBucket[]): RiskSignalBucket[] {
  return buckets
    .filter((bucket) => Number.isSafeInteger(bucket.count) && bucket.count > 0)
    .map((bucket) => ({ ...bucket }))
    .sort((left, right) => {
      const kind = left.kind.localeCompare(right.kind);
      if (kind !== 0) return kind;
      return SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
    });
}

/**
 * Pure explainable ruleset. Every escalation is attributable to a named rule;
 * counts are facts, not weights. No additive score exists.
 *
 * Neutral context:
 * - REPORT_SUBMITTED is unconfirmed allegation context only.
 * - RENTAL_DISPUTE_OPENED is bilateral dispute context only.
 * Both can request observation, but never REVIEW/PRIORITY_REVIEW on their own.
 *
 * Human-confirmed/manual signals:
 * - REPORT_CONFIRMED => REVIEW; HIGH => PRIORITY_REVIEW.
 * - MANUAL_FLAG MEDIUM/HIGH => REVIEW/PRIORITY_REVIEW.
 * - MANUAL_FLAG INFO/LOW => OBSERVE.
 *
 * This function only recommends attention. It does not mutate RiskState or
 * EnforcementAction and MUST NOT be used as an authorization predicate.
 */
export function evaluateRiskSignalBuckets(
  buckets: RiskSignalBucket[],
): {
  attentionLevel: RiskAttentionLevel;
  recommendedAction: RiskRecommendedAction;
  matchedRules: RiskMatchedRule[];
  activeSignalCount: number;
  signalBreakdown: RiskSignalBucket[];
} {
  const signalBreakdown = normalizeBuckets(buckets);
  const activeSignalCount = signalBreakdown.reduce(
    (sum, bucket) => sum + bucket.count,
    0,
  );

  let attentionLevel: RiskAttentionLevel = "CLEAR";
  const matchedRules: RiskMatchedRule[] = [];

  const manualHigh = countSignals(
    signalBreakdown,
    (bucket) => bucket.kind === "MANUAL_FLAG" && bucket.severity === "HIGH",
  );
  if (manualHigh > 0) {
    matchedRules.push({ ruleId: "MANUAL_HIGH_SIGNAL", signalCount: manualHigh });
    attentionLevel = maxAttention(attentionLevel, "PRIORITY_REVIEW");
  }

  const confirmedHigh = countSignals(
    signalBreakdown,
    (bucket) =>
      bucket.kind === "REPORT_CONFIRMED" && bucket.severity === "HIGH",
  );
  if (confirmedHigh > 0) {
    matchedRules.push({
      ruleId: "CONFIRMED_HIGH_SIGNAL",
      signalCount: confirmedHigh,
    });
    attentionLevel = maxAttention(attentionLevel, "PRIORITY_REVIEW");
  }

  const confirmedReports = countSignals(
    signalBreakdown,
    (bucket) => bucket.kind === "REPORT_CONFIRMED",
  );
  if (confirmedReports > 0) {
    matchedRules.push({
      ruleId: "CONFIRMED_REPORT_PRESENT",
      signalCount: confirmedReports,
    });
    attentionLevel = maxAttention(attentionLevel, "REVIEW");
  }

  const manualReview = countSignals(
    signalBreakdown,
    (bucket) =>
      bucket.kind === "MANUAL_FLAG" &&
      (bucket.severity === "MEDIUM" || bucket.severity === "HIGH"),
  );
  if (manualReview > 0) {
    matchedRules.push({
      ruleId: "MANUAL_REVIEW_SIGNAL",
      signalCount: manualReview,
    });
    attentionLevel = maxAttention(attentionLevel, "REVIEW");
  }

  const unconfirmedReports = countSignals(
    signalBreakdown,
    (bucket) => bucket.kind === "REPORT_SUBMITTED",
  );
  if (unconfirmedReports > 0) {
    matchedRules.push({
      ruleId: "UNCONFIRMED_REPORT_CONTEXT",
      signalCount: unconfirmedReports,
    });
    attentionLevel = maxAttention(attentionLevel, "OBSERVE");
  }

  const disputeContext = countSignals(
    signalBreakdown,
    (bucket) => bucket.kind === "RENTAL_DISPUTE_OPENED",
  );
  if (disputeContext > 0) {
    matchedRules.push({
      ruleId: "DISPUTE_CONTEXT_ONLY",
      signalCount: disputeContext,
    });
    attentionLevel = maxAttention(attentionLevel, "OBSERVE");
  }

  const lowManual = countSignals(
    signalBreakdown,
    (bucket) =>
      bucket.kind === "MANUAL_FLAG" &&
      (bucket.severity === "INFO" || bucket.severity === "LOW"),
  );
  if (lowManual > 0) {
    // Reuse the explicit manual-review signal rule id while preserving the
    // lower OBSERVE semantics for low-severity human context.
    matchedRules.push({
      ruleId: "MANUAL_REVIEW_SIGNAL",
      signalCount: lowManual,
    });
    attentionLevel = maxAttention(attentionLevel, "OBSERVE");
  }

  return {
    attentionLevel,
    recommendedAction: recommendationFor(attentionLevel),
    matchedRules,
    activeSignalCount,
    signalBreakdown,
  };
}

type AuthorizedRiskScope = {
  scope: RiskEvaluationScope;
  whereScope: Prisma.RiskFlagWhereInput;
};

/**
 * Authorization happens before the query shape is built.
 *
 * - GLOBAL risk.read: may evaluate ALL_SCOPES, or request one exact campus.
 * - campus-only risk.read: MUST name one campus already present in access.
 * - campus evaluation uses exact campusId only. GLOBAL/unscoped and other-campus
 *   RiskFlag rows are structurally excluded in SQL and never fetched then filtered.
 */
export function resolveAuthorizedRiskScope(
  access: RiskReadAccess,
  campusId?: string,
): AuthorizedRiskScope {
  if (campusId !== undefined && campusId.length === 0) {
    throw new Error("RISK_INTELLIGENCE_SCOPE_INVALID");
  }

  if (access.global) {
    return campusId === undefined
      ? { scope: { kind: "ALL_SCOPES" }, whereScope: {} }
      : {
          scope: { kind: "CAMPUS", campusId },
          whereScope: { campusId },
        };
  }

  if (campusId === undefined || !access.campusIds.includes(campusId)) {
    throw new Error("RISK_INTELLIGENCE_SCOPE_DENIED");
  }

  return {
    scope: { kind: "CAMPUS", campusId },
    whereScope: { campusId },
  };
}

/**
 * Authorized current risk intelligence read model.
 *
 * Canonical inputs are ACTIVE RiskFlag rows. The engine does not read or write
 * RiskState/EnforcementAction, so evaluating risk can never become a hidden
 * enforcement path. Missing user and user-with-no-signals intentionally both
 * evaluate to CLEAR from this signal-only surface (no user existence oracle).
 *
 * Full counts use groupBy (bounded by enum combinations); raw evidence is capped
 * at RISK_SIGNAL_EVIDENCE_LIMIT and excludes note/reason/sourceId/actor identity.
 */
export async function loadAuthorizedRiskIntelligence(input: {
  access: RiskReadAccess;
  targetUserId: string;
  campusId?: string;
  evaluatedAt?: Date;
}): Promise<RiskIntelligenceAssessment> {
  if (!input.targetUserId) {
    throw new Error("RISK_INTELLIGENCE_TARGET_REQUIRED");
  }

  const authorized = resolveAuthorizedRiskScope(input.access, input.campusId);
  const where: Prisma.RiskFlagWhereInput = {
    userId: input.targetUserId,
    status: "ACTIVE",
    ...authorized.whereScope,
  };

  const [groups, evidenceRows] = await Promise.all([
    prisma.riskFlag.groupBy({
      by: ["kind", "severity"],
      where,
      _count: { _all: true },
    }),
    prisma.riskFlag.findMany({
      where,
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }, { id: "asc" }],
      take: RISK_SIGNAL_EVIDENCE_LIMIT,
      select: {
        id: true,
        kind: true,
        severity: true,
        campusId: true,
        sourceType: true,
        createdAt: true,
      },
    }),
  ]);

  const evaluated = evaluateRiskSignalBuckets(
    groups.map((group) => ({
      kind: group.kind,
      severity: group.severity,
      count: group._count._all,
    })),
  );

  const evidence: RiskSignalEvidence[] = evidenceRows.map((row) => ({
    signalId: row.id,
    kind: row.kind,
    severity: row.severity,
    campusId: row.campusId,
    sourceType: row.sourceType,
    createdAt: row.createdAt.toISOString(),
  }));

  return {
    targetUserId: input.targetUserId,
    rulesetVersion: RISK_RULESET_VERSION,
    evaluatedAt: (input.evaluatedAt ?? new Date()).toISOString(),
    scope: authorized.scope,
    ...evaluated,
    evidence,
    evidenceTruncated: evaluated.activeSignalCount > evidence.length,
  };
}
