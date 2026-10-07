import {
  analyticsProjectDomainEventPayloadSchema,
  PermanentJobFailure,
  type JobHandler,
} from "@/lib/async/job-types";
import { projectDomainEventTx } from "@/lib/analytics/domain-event-projection";
import {
  ANALYTICS_METRIC_PROJECTION_VERSION,
  buildLiveDomainEventProjectionDedupeKey,
  parseDomainEventProjectionVersion,
} from "@/lib/analytics/projection-contract";

export const analyticsProjectDomainEventHandler: JobHandler = async (tx, job) => {
  const parsed = analyticsProjectDomainEventPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    throw new PermanentJobFailure(
      "ANALYTICS_PROJECT_DOMAIN_EVENT_PAYLOAD_INVALID",
      "analytics projection job payload 非法",
    );
  }

  // Projection version is deployment authority, not caller payload. During a
  // rolling deploy:
  // - older intent < current runtime: stale, safe idempotent completion;
  // - future intent > current runtime: this old worker MUST NOT consume it.
  //   Reschedule lets a newer worker execute it after rollout convergence.
  const intentProjectionVersion = parseDomainEventProjectionVersion(
    job.dedupeKey,
    parsed.data.eventId,
  );
  if (intentProjectionVersion === null) {
    throw new PermanentJobFailure(
      "ANALYTICS_PROJECTION_DEDUPE_INVALID",
      `analytics projection dedupe identity 非法：jobId=${job.id}`,
    );
  }
  if (intentProjectionVersion < ANALYTICS_METRIC_PROJECTION_VERSION) {
    return { kind: "COMPLETED_IDEMPOTENT" };
  }
  if (intentProjectionVersion > ANALYTICS_METRIC_PROJECTION_VERSION) {
    return { kind: "RESCHEDULE", runAt: new Date(Date.now() + 60_000) };
  }

  const canonicalDedupeKey = buildLiveDomainEventProjectionDedupeKey(parsed.data.eventId);
  if (job.dedupeKey !== canonicalDedupeKey) {
    throw new PermanentJobFailure(
      "ANALYTICS_PROJECTION_DEDUPE_INVALID",
      `analytics projection dedupe identity 非法：jobId=${job.id}`,
    );
  }

  const result = await projectDomainEventTx(tx, parsed.data.eventId);
  return result.projected ? { kind: "COMPLETED" } : { kind: "COMPLETED_IDEMPOTENT" };
};
