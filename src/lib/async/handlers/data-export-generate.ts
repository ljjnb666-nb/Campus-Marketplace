import type { Prisma } from "@prisma/client";

import { processDataExportGenerateJob } from "@/lib/privacy/data-export-async";
import type { ClaimedAsyncJob, JobHandler } from "@/lib/async/job-types";

/**
 * Phase 9C-03：DATA_EXPORT_GENERATE@1 handler 注册壳。
 *
 * 职责只有把 runner 提供的 execution tx 转交给 canonical domain lifecycle
 * （processDataExportGenerateJob）——handler 绝不自持状态机，与 9A/9B/
 * 9C-02 handler 同一结构惯例。Step A/B / erasure race / 资源上界语义见
 * data-export-async.ts 与 data-export-contract.ts。
 */
export const dataExportGenerateHandler: JobHandler = (
  tx: Prisma.TransactionClient,
  job: ClaimedAsyncJob,
) => processDataExportGenerateJob(tx, job);
