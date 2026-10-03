import { describe, expect, it } from "vitest";

import { resolveJobExecutionPolicy, resolveJobHandler } from "./job-registry";
import { resolveOutboxEventHandler } from "./outbox-registry";
import {
  NOTIFICATION_DELIVERY_JOB_KIND,
  NOTIFICATION_DELIVERY_JOB_SCHEMA_VERSION,
  PRODUCT_RESERVATION_EXPIRE_JOB_KIND,
  PRODUCT_RESERVATION_EXPIRE_JOB_SCHEMA_VERSION,
} from "./job-types";
import {
  EMAIL_DELIVERY_EXECUTION_LEASE_SECONDS,
  EMAIL_DELIVERY_EXECUTION_TX_TIMEOUT_MS,
  EMAIL_PROVIDER_TIMEOUT_MS_MAX,
} from "@/lib/notifications/email-contract";
import {
  PRODUCT_RESERVATION_EXPIRED_EVENT_SCHEMA_VERSION,
  PRODUCT_RESERVATION_EXPIRED_EVENT_TYPE,
} from "./outbox-event-registry";

describe("Phase 9B RB06：per-job execution policy（SSOT = job registry）", () => {
  it("EMAIL-TX-BUDGET-01：EMAIL execution tx 预算 > provider timeout max + >=20s safety margin", () => {
    expect(EMAIL_DELIVERY_EXECUTION_TX_TIMEOUT_MS).toBeGreaterThan(
      EMAIL_PROVIDER_TIMEOUT_MS_MAX + 20_000,
    );
  });

  it("EMAIL-LEASE-BUDGET-01：execution lease > execution tx max + >=10s completion margin", () => {
    expect(EMAIL_DELIVERY_EXECUTION_LEASE_SECONDS * 1000).toBeGreaterThan(
      EMAIL_DELIVERY_EXECUTION_TX_TIMEOUT_MS + 10_000,
    );
  });

  it("NOTIFICATION_DELIVERY@1 解析为 extended policy；9A PRODUCT_RESERVATION_EXPIRE@1 保持默认（不被污染）", () => {
    expect(resolveJobExecutionPolicy(NOTIFICATION_DELIVERY_JOB_KIND, NOTIFICATION_DELIVERY_JOB_SCHEMA_VERSION)).toEqual({
      transactionTimeoutMs: EMAIL_DELIVERY_EXECUTION_TX_TIMEOUT_MS,
      executionLeaseSeconds: EMAIL_DELIVERY_EXECUTION_LEASE_SECONDS,
    });
    // 既有 9A handler：无覆盖 → runner 继承既有默认（TRANSACTION_TIMEOUT_MS / 60s lease）
    expect(
      resolveJobExecutionPolicy(PRODUCT_RESERVATION_EXPIRE_JOB_KIND, PRODUCT_RESERVATION_EXPIRE_JOB_SCHEMA_VERSION),
    ).toEqual({});
  });

  it("未知 kind/version → {}（unknown-job PERMANENT → DEAD_LETTER 合同不受 policy 影响）", () => {
    expect(resolveJobExecutionPolicy("NO_SUCH_KIND", 1)).toEqual({});
    expect(resolveJobExecutionPolicy(NOTIFICATION_DELIVERY_JOB_KIND, 999)).toEqual({});
  });
});

describe("Phase 9A runtime registry fail closed（§6/§22）", () => {
  it("已注册 job kind + schemaVersion 可解析", () => {
    expect(
      resolveJobHandler(PRODUCT_RESERVATION_EXPIRE_JOB_KIND, PRODUCT_RESERVATION_EXPIRE_JOB_SCHEMA_VERSION),
    ).toBeTypeOf("function");
  });

  it("未知 job kind / 未知 schemaVersion → null（调用方必须 PERMANENT → DEAD_LETTER）", () => {
    expect(resolveJobHandler("EMAIL_DELIVERY", 1)).toBeNull();
    expect(resolveJobHandler(PRODUCT_RESERVATION_EXPIRE_JOB_KIND, 999)).toBeNull();
    expect(resolveJobHandler("", 1)).toBeNull();
  });

  it("已注册 outbox eventType + version 可解析", () => {
    expect(
      resolveOutboxEventHandler(
        PRODUCT_RESERVATION_EXPIRED_EVENT_TYPE,
        PRODUCT_RESERVATION_EXPIRED_EVENT_SCHEMA_VERSION,
      ),
    ).toBeTypeOf("function");
  });

  it("未知 outbox eventType / 未知 version → null", () => {
    expect(resolveOutboxEventHandler("ORDER_COMPLETED", 1)).toBeNull();
    expect(resolveOutboxEventHandler(PRODUCT_RESERVATION_EXPIRED_EVENT_TYPE, 2)).toBeNull();
  });
});
