import {
  analyticsProjectDomainEventPayloadSchema,
  PermanentJobFailure,
  type JobHandler,
} from "@/lib/async/job-types";
import { projectDomainEventTx } from "@/lib/analytics/domain-event-projection";
import { buildLiveDomainEventProjectionDedupeKey } from "@/lib/analytics/projection-contract";

export const analyticsProjectDomainEventHandler: JobHandler = async (tx, job) => {
  const parsed = analyticsProjectDomainEventPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    throw new PermanentJobFailure(
      "ANALYTICS_PROJECT_DOMAIN_EVENT_PAYLOAD_INVALID",
      "analytics projection job payload 非法",
    );
  }

  // Projection version is deployment authority, not caller payload. The durable
  // dedupeKey captures the version that created this intent. During a rolling
  // upgrade, a stale vN job must never execute current vN+1 semantics.
  const canonicalDedupeKey = buildLiveDomainEventProjectionDedupeKey(parsed.data.eventId);
  if (job.dedupeKey !== canonicalDedupeKey) {
    return { kind: "COMPLETED_IDEMPOTENT" };
  }

  const result = await projectDomainEventTx(tx, parsed.data.eventId);
  return result.projected ? { kind: "COMPLETED" } : { kind: "COMPLETED_IDEMPOTENT" };
};
