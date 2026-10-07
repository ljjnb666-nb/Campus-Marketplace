import {
  ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_KIND,
  ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_SCHEMA_VERSION,
} from "@/lib/async/job-types";

/**
 * Phase 10B current analytics projection identity。
 *
 * 正确性永远以 ProjectionReceipt(projectionKey,eventId,projectionVersion)
 * 为 authority。版本升级/重建时提升 ANALYTICS_METRIC_PROJECTION_VERSION；
 * bounded scheduler 会把所有历史 DomainEvent 重新送入现有 AsyncJob，
 * 无需 watermark，也不删除旧 receipt。
 */
export const ANALYTICS_METRIC_PROJECTION_KEY = "ANALYTICS_METRIC_CONTRIBUTIONS";
export const ANALYTICS_METRIC_PROJECTION_VERSION = 2;

export type ProjectionIntentVersionDisposition = "STALE" | "CURRENT" | "FUTURE";

/**
 * Pure rolling-deploy classifier. Keeping currentVersion injectable makes the
 * v1 implementation able to prove future v2 behavior without inventing an
 * invalid projection version 0.
 */
export function classifyProjectionIntentVersion(
  intentVersion: number,
  currentVersion = ANALYTICS_METRIC_PROJECTION_VERSION,
): ProjectionIntentVersionDisposition {
  if (
    !Number.isSafeInteger(intentVersion) ||
    intentVersion < 1 ||
    !Number.isSafeInteger(currentVersion) ||
    currentVersion < 1
  ) {
    throw new Error("ANALYTICS_PROJECTION_VERSION_INVALID");
  }
  if (intentVersion < currentVersion) {
    return "STALE";
  }
  if (intentVersion > currentVersion) {
    return "FUTURE";
  }
  return "CURRENT";
}

export function buildLiveDomainEventProjectionDedupeKey(eventId: string): string {
  return [
    ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_KIND,
    `schema${ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_SCHEMA_VERSION}`,
    `projection${ANALYTICS_METRIC_PROJECTION_VERSION}`,
    eventId,
  ].join(":");
}

export function parseDomainEventProjectionVersion(
  dedupeKey: string | undefined,
  eventId: string,
): number | null {
  if (!dedupeKey) {
    return null;
  }
  const prefix = [
    ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_KIND,
    `schema${ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_SCHEMA_VERSION}`,
    "projection",
  ].join(":");
  const suffix = `:${eventId}`;
  if (!dedupeKey.startsWith(prefix) || !dedupeKey.endsWith(suffix)) {
    return null;
  }
  const rawVersion = dedupeKey.slice(prefix.length, dedupeKey.length - suffix.length);
  if (!/^[1-9][0-9]*$/.test(rawVersion)) {
    return null;
  }
  const parsed = Number(rawVersion);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
