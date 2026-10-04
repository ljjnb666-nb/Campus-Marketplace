import { describe, expect, it } from "vitest";

import {
  DATA_EXPORT_GENERATE_EXECUTION_LEASE_SECONDS,
  DATA_EXPORT_GENERATE_EXECUTION_TX_TIMEOUT_MS,
  DATA_EXPORT_S3_PUT_OPERATION_TIMEOUT_MS,
  buildDataExportObjectKey,
  dataExportArtifactExpiresAt,
  dataExportArtifactMaxBytes,
} from "@/lib/privacy/data-export-contract";
import {
  canTransitionArtifact,
  markArtifactDeletedIfPendingDelete,
} from "@/lib/privacy/data-export-artifact";
import { TRANSACTION_TIMEOUT_MS } from "@/lib/prisma";
import { dataExportGeneratePayloadSchema } from "@/lib/async/job-types";

/**
 * Phase 9C-03 纯契约层测试（EXPORT-TX-BUDGET-01 / EXPORT-LEASE-BUDGET-01 /
 * EXPORT-KEY-01 / EXPORT-PAYLOAD-CONTRACT）：
 *
 * - deterministic object key：requestId → exactly one object key（§11）
 * - payload 契约 strict（§5）：未知键拒绝，只允许 requestId
 * - execution budget 算术冻结（§47/§48）：lease > tx budget > 默认预算，
 *   PUT 操作预算有界
 * - artifact 状态机迁移表（PENDING_DELETE → DELETED 只经条件谓词）
 */

const USER_ID = "c0ffee000000000000000001";
const REQUEST_ID = "c0ffee00000000000000000r";

describe("EXPORT-KEY-01：deterministic object key", () => {
  it("requestId → exactly one object key（多次生成稳定一致）", () => {
    const first = buildDataExportObjectKey(USER_ID, REQUEST_ID);
    const second = buildDataExportObjectKey(USER_ID, REQUEST_ID);

    expect(first).toBe(second);
    expect(first).toBe(`private/data-exports/${USER_ID}/${REQUEST_ID}.json`);
  });

  it("不同 requestId → 不同 key（绝不共享）", () => {
    const other = buildDataExportObjectKey(USER_ID, "c0ffee00000000000000000s");
    expect(other).not.toBe(buildDataExportObjectKey(USER_ID, REQUEST_ID));
  });

  it("拒绝非法 ID 形态与穿越形态", () => {
    expect(() => buildDataExportObjectKey("../etc", REQUEST_ID)).toThrow();
    expect(() => buildDataExportObjectKey(USER_ID, "BAD;DROP TABLE")).toThrow();
    expect(() => buildDataExportObjectKey(USER_ID, "short")).toThrow();
  });
});

describe("EXPORT-PAYLOAD-CONTRACT：DATA_EXPORT_GENERATE payload strict 契约", () => {
  it("只允许 requestId；未知键拒绝（绝不 parse-success + silently strip）", () => {
    expect(dataExportGeneratePayloadSchema.safeParse({ requestId: REQUEST_ID }).success).toBe(true);

    const withUnknown = dataExportGeneratePayloadSchema.safeParse({
      requestId: REQUEST_ID,
      objectKey: "private/data-exports/x.json",
    });
    expect(withUnknown.success).toBe(false);

    expect(
      dataExportGeneratePayloadSchema.safeParse({ requestId: REQUEST_ID, email: "a@b.c" }).success,
    ).toBe(false);

    expect(dataExportGeneratePayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe("EXPORT-TX-BUDGET-01 / EXPORT-LEASE-BUDGET-01：execution budget 算术冻结", () => {
  it("execution lease > worst-case transaction budget + completion margin", () => {
    // EMAIL-LEASE 同一算术：COMMIT 后 completion marker 落库前不得进入
    // expired-lease reclaim 窗口（9A crash-recovery 合同）
    expect(DATA_EXPORT_GENERATE_EXECUTION_LEASE_SECONDS * 1000).toBeGreaterThanOrEqual(
      DATA_EXPORT_GENERATE_EXECUTION_TX_TIMEOUT_MS + 10_000,
    );
  });

  it("tx budget 覆盖默认事务预算 + 有界 PUT 预算（不得依赖默认 10s 猜测）", () => {
    expect(DATA_EXPORT_GENERATE_EXECUTION_TX_TIMEOUT_MS).toBeGreaterThan(TRANSACTION_TIMEOUT_MS);
    expect(DATA_EXPORT_GENERATE_EXECUTION_TX_TIMEOUT_MS).toBeGreaterThanOrEqual(
      20_000 + DATA_EXPORT_S3_PUT_OPERATION_TIMEOUT_MS,
    );
    // 有界性（§48）：预算必须有限且合理，禁止无界超时掩盖架构问题
    expect(DATA_EXPORT_GENERATE_EXECUTION_TX_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
    expect(DATA_EXPORT_GENERATE_EXECUTION_LEASE_SECONDS).toBeLessThanOrEqual(300);
  });
});

describe("EXPORT-ASYNC-LIMIT：async 资源上界（§15）", () => {
  it("默认/配置下限严格高于旧 8 MiB sync limit（>8MiB 导出是本阶段红线）", () => {
    const maxBytes = dataExportArtifactMaxBytes();
    expect(maxBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(maxBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
  });

  it("TTL 默认 24h，从 READY 起算", () => {
    const readyAt = new Date("2026-10-04T00:00:00Z");
    const expiresAt = dataExportArtifactExpiresAt(readyAt);
    const hours = (expiresAt.getTime() - readyAt.getTime()) / (60 * 60 * 1000);
    expect(hours).toBeGreaterThanOrEqual(1);
    expect(hours).toBeLessThanOrEqual(168);
    expect(hours).toBe(24);
  });
});

describe("EXPORT-ARTIFACT-STATE-MACHINE：迁移表", () => {
  it("合法迁移：WRITING→READY / WRITING→PENDING_DELETE / READY→PENDING_DELETE / PENDING_DELETE→DELETED", () => {
    expect(canTransitionArtifact("WRITING", "READY")).toBe(true);
    expect(canTransitionArtifact("WRITING", "PENDING_DELETE")).toBe(true);
    expect(canTransitionArtifact("READY", "PENDING_DELETE")).toBe(true);
    expect(canTransitionArtifact("PENDING_DELETE", "DELETED")).toBe(true);
  });

  it("非法迁移全部拒绝（READY→WRITING / DELETED→* / 终态复活）", () => {
    expect(canTransitionArtifact("READY", "WRITING")).toBe(false);
    expect(canTransitionArtifact("DELETED", "READY")).toBe(false);
    expect(canTransitionArtifact("DELETED", "PENDING_DELETE")).toBe(false);
    expect(canTransitionArtifact("WRITING", "DELETED")).toBe(false);
  });

  it("DELETED 推进只经 PENDING_DELETE 谓词（§28 two-workers exactly-once）", () => {
    // markArtifactDeletedIfPendingDelete 的条件语义在集成测试用真实 PG 证明；
    // 此处锁定其存在且从模块面收敛（禁止绕过状态机任意 UPDATE 的旁路）。
    expect(typeof markArtifactDeletedIfPendingDelete).toBe("function");
  });
});
