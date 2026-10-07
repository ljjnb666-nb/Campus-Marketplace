import {
  analyticsProjectDomainEventPayloadSchema,
  PermanentJobFailure,
  type JobHandler,
} from "@/lib/async/job-types";
import { projectDomainEventTx } from "@/lib/analytics/domain-event-projection";

export const analyticsProjectDomainEventHandler: JobHandler = async (tx, job) => {
  const parsed = analyticsProjectDomainEventPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    throw new PermanentJobFailure(
      "ANALYTICS_PROJECT_DOMAIN_EVENT_PAYLOAD_INVALID",
      "analytics projection job payload 非法",
    );
  }

  const result = await projectDomainEventTx(tx, parsed.data.eventId);
  return result.projected ? { kind: "COMPLETED" } : { kind: "COMPLETED_IDEMPOTENT" };
};
