import { describe, expect, it } from "vitest";

import { resolveJobHandler } from "./job-registry";
import { resolveOutboxEventHandler } from "./outbox-registry";
import {
  PRODUCT_RESERVATION_EXPIRE_JOB_KIND,
  PRODUCT_RESERVATION_EXPIRE_JOB_SCHEMA_VERSION,
} from "./job-types";
import {
  PRODUCT_RESERVATION_EXPIRED_EVENT_SCHEMA_VERSION,
  PRODUCT_RESERVATION_EXPIRED_EVENT_TYPE,
} from "./outbox-event-registry";

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
