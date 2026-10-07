import { describe, expect, it } from "vitest";

import { getFieldPrivacyPolicy } from "@/lib/privacy/privacy-data-registry";
import {
  classifyJobFailure,
  jobErrorCode,
  jobErrorMessage,
  PermanentJobFailure,
  productReservationExpirePayloadSchema,
  safeAsyncErrorCode,
  validateJobIntent,
  ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_KIND,
  ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_SCHEMA_VERSION,
  analyticsProjectDomainEventPayloadSchema,
  ERRAND_DEADLINE_EXPIRE_JOB_KIND,
  ERRAND_DEADLINE_EXPIRE_JOB_SCHEMA_VERSION,
  errandDeadlineExpirePayloadSchema,
  PRODUCT_RESERVATION_EXPIRE_JOB_KIND,
  PRODUCT_RESERVATION_EXPIRE_JOB_SCHEMA_VERSION,
} from "./job-types";

describe("Phase 9A job failure 分类与错误消毒（§17/§18）", () => {
  it("PermanentJobFailure → PERMANENT；普通 Error / 未知异常 → RETRYABLE", () => {
    expect(classifyJobFailure(new PermanentJobFailure("X"))).toBe("PERMANENT");
    expect(classifyJobFailure(new Error("boom"))).toBe("RETRYABLE");
    expect(classifyJobFailure("random failure")).toBe("RETRYABLE");
    expect(classifyJobFailure(undefined)).toBe("RETRYABLE");
  });

  it("error code 提取：PermanentJobFailure.code 优先；Prisma 机器码需 name+P#### 双命中；否则安全 name / UNKNOWN", () => {
    expect(jobErrorCode(new PermanentJobFailure("SOME_STRUCTURAL_CORRUPTION"))).toBe(
      "SOME_STRUCTURAL_CORRUPTION",
    );
    // RB05：Prisma known request 机器码（name + P#### 双命中）
    const prismaKnownError = Object.assign(new Error("unique constraint"), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    });
    expect(jobErrorCode(prismaKnownError)).toBe("P2002");
    // arbitrary code 字段（无 Prisma name）→ 拒绝，回落安全 name
    const arbitraryCodeError = Object.assign(new Error("unique constraint"), { code: "P2002" });
    expect(jobErrorCode(arbitraryCodeError)).toBe("Error");
    expect(jobErrorCode(new TypeError("oops"))).toBe("TypeError");
    expect(jobErrorCode("no error object")).toBe("UNKNOWN");
  });

  it("RB02 ERR-SAFE：raw exception message 默认拒绝落库（固定 generic message）", () => {
    // 秘密格式无限 → 不做正则黑名单，DENY raw message BY DEFAULT
    const leaky = new Error("password=super-secret jwt=abc.def.ghi user note=私密内容");
    expect(jobErrorMessage(leaky)).toBe("异步任务执行失败");
    expect(jobErrorMessage(leaky)).not.toContain("super-secret");
    expect(jobErrorMessage(leaky)).not.toContain("abc.def.ghi");
    expect(jobErrorMessage(leaky)).not.toContain("私密内容");
    expect(jobErrorMessage("plain string failure")).toBe("异步任务执行失败");
    expect(jobErrorMessage(undefined)).toBe("异步任务执行失败");
  });

  it("RB02 ERR-SAFE：PermanentJobFailure 受控内部文案允许（仍消毒：首行 / 控制字符 / <=500）", () => {
    const controlled = new PermanentJobFailure(
      "PRODUCT_RESERVATION_STRUCTURAL_INVALID",
      "PRODUCT reservation target invalid: order-1",
    );
    expect(jobErrorMessage(controlled)).toBe("PRODUCT reservation target invalid: order-1");

    const multilineControlled = new PermanentJobFailure(
      "X",
      "first line\nstack-ish line",
    );
    expect(jobErrorMessage(multilineControlled)).toBe("first line");

    const longControlled = new PermanentJobFailure("X", "y".repeat(800));
    expect(jobErrorMessage(longControlled)).toHaveLength(500);
  });

  it("RB02 privacy registry：async error 元数据 = OPERATOR_ONLY / EXCLUDE（machine-only 声明成立）", () => {
    for (const [model, field] of [
      ["AsyncJob", "lastErrorCode"],
      ["AsyncJob", "lastErrorMessage"],
      ["OutboxEvent", "lastErrorCode"],
      ["OutboxEvent", "lastErrorMessage"],
    ] as const) {
      const policy = getFieldPrivacyPolicy(model, field);
      expect(policy, `${model}.${field} 必须有显式分类`).not.toBeNull();
      expect(policy!.classification).toBe("OPERATOR_ONLY");
      expect(policy!.selfExport).toBe("EXCLUDE");
      expect(policy!.secondaryCopyAllowed).toBe(false);
      expect(policy!.logSafe).toBe(false);
    }
  });

  it("RB04 strict payload schema：未知键即 INVALID（绝不 parse-success + silently strip）", () => {
    expect(productReservationExpirePayloadSchema.safeParse({ orderId: "order-1" }).success).toBe(
      true,
    );
    // 多余键拒绝（strict）：strip 只保护 parse 结果，不阻止原始 JSON 落库
    expect(
      productReservationExpirePayloadSchema.safeParse({ orderId: "order-1", note: "hack" })
        .success,
    ).toBe(false);
    expect(productReservationExpirePayloadSchema.safeParse({}).success).toBe(false);
    expect(productReservationExpirePayloadSchema.safeParse({ orderId: "" }).success).toBe(false);
  });

  it("Phase 9C-02 ERRAND_DEADLINE_EXPIRE@1 契约：payload 仅 errandId，strict 拒绝未知键与用户文本", () => {
    expect(ERRAND_DEADLINE_EXPIRE_JOB_KIND).toBe("ERRAND_DEADLINE_EXPIRE");
    expect(ERRAND_DEADLINE_EXPIRE_JOB_SCHEMA_VERSION).toBe(1);

    expect(errandDeadlineExpirePayloadSchema.safeParse({ errandId: "errand-1" }).success).toBe(
      true,
    );
    // 多余键（含用户文本）拒绝
    expect(
      errandDeadlineExpirePayloadSchema.safeParse({ errandId: "errand-1", title: "取件" })
        .success,
    ).toBe(false);
    expect(errandDeadlineExpirePayloadSchema.safeParse({}).success).toBe(false);
    expect(errandDeadlineExpirePayloadSchema.safeParse({ errandId: "" }).success).toBe(false);

    // 写边界契约：canonical 形状通过；未知 version / 非法形状拒绝
    const canonical = validateJobIntent(
      ERRAND_DEADLINE_EXPIRE_JOB_KIND,
      ERRAND_DEADLINE_EXPIRE_JOB_SCHEMA_VERSION,
      { errandId: "errand-1" },
    );
    expect(canonical).toEqual({ ok: true, payload: { errandId: "errand-1" } });
    expect(
      validateJobIntent(ERRAND_DEADLINE_EXPIRE_JOB_KIND, 999, { errandId: "errand-1" }),
    ).toEqual({ ok: false, reason: "UNKNOWN_CONTRACT" });
    expect(
      validateJobIntent(ERRAND_DEADLINE_EXPIRE_JOB_KIND, 1, { errandId: "errand-1", note: "x" }),
    ).toEqual({ ok: false, reason: "INVALID_PAYLOAD" });
  });

  it("Phase 10B ANALYTICS_PROJECT_DOMAIN_EVENT@1：payload 仅 eventId，strict 拒绝 free text", () => {
    expect(ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_KIND).toBe("ANALYTICS_PROJECT_DOMAIN_EVENT");
    expect(ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_SCHEMA_VERSION).toBe(1);
    expect(analyticsProjectDomainEventPayloadSchema.safeParse({ eventId: "event-1" }).success).toBe(true);
    expect(
      analyticsProjectDomainEventPayloadSchema.safeParse({ eventId: "event-1", note: "用户文本" }).success,
    ).toBe(false);
    expect(
      validateJobIntent(
        ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_KIND,
        ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_SCHEMA_VERSION,
        { eventId: "event-1" },
      ),
    ).toEqual({ ok: true, payload: { eventId: "event-1" } });
  });

  it("RB04 validateJobIntent：已知契约返回 canonical payload；未知契约/非法形状拒绝", () => {
    const valid = validateJobIntent(
      PRODUCT_RESERVATION_EXPIRE_JOB_KIND,
      PRODUCT_RESERVATION_EXPIRE_JOB_SCHEMA_VERSION,
      { orderId: "order-1", extra: "must-strip-or-reject" },
    );
    expect(valid.ok).toBe(false);
    expect(valid).toEqual({ ok: false, reason: "INVALID_PAYLOAD" });

    const canonical = validateJobIntent(
      PRODUCT_RESERVATION_EXPIRE_JOB_KIND,
      PRODUCT_RESERVATION_EXPIRE_JOB_SCHEMA_VERSION,
      { orderId: "order-1" },
    );
    expect(canonical).toEqual({ ok: true, payload: { orderId: "order-1" } });

    expect(
      validateJobIntent("UNKNOWN_JOB", 1, { orderId: "order-1" }),
    ).toEqual({ ok: false, reason: "UNKNOWN_CONTRACT" });
    expect(
      validateJobIntent(PRODUCT_RESERVATION_EXPIRE_JOB_KIND, 999, { orderId: "order-1" }),
    ).toEqual({ ok: false, reason: "UNKNOWN_CONTRACT" });
  });

  it("RB05：lastErrorCode 只允许受控/机器码（allowlist deny-by-default），arbitrary error.code 拒绝", () => {
    // arbitrary exception 附加字段（可携带 secret / free text）→ 拒绝，
    // 回落安全机器格式的 Error.name
    const leaky = Object.assign(new Error("boom"), {
      code: "password=super-secret jwt=abc.def.ghi user@email.com",
    });
    expect(jobErrorCode(leaky)).toBe("Error");
    expect(jobErrorCode(leaky)).not.toContain("super-secret");
    expect(jobErrorCode(leaky)).not.toContain("abc.def.ghi");
    expect(jobErrorCode(leaky)).not.toContain("user@email.com");

    // Prisma known request 机器码：name + P#### 格式同时命中才放行
    const prismaKnown = Object.assign(new Error("x"), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    });
    expect(jobErrorCode(prismaKnown)).toBe("P2002");
    // name 冒充 Prisma 但格式不符 → 不放行 code
    const fakePrisma = Object.assign(new Error("x"), {
      name: "NotPrisma",
      code: "P2002",
    });
    expect(jobErrorCode(fakePrisma)).toBe("NotPrisma");

    // Node 传输码：显式 allowlist
    expect(jobErrorCode(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(
      "ECONNRESET",
    );
    expect(jobErrorCode(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe("ETIMEDOUT");
    // 非白名单的自造 code → 不放行
    expect(jobErrorCode(Object.assign(new Error("x"), { code: "SOME_WEIRD_CODE" }))).toBe("Error");

    // 受控内部码：放行
    expect(jobErrorCode(new PermanentJobFailure("PRODUCT_RESERVATION_STRUCTURAL_INVALID"))).toBe(
      "PRODUCT_RESERVATION_STRUCTURAL_INVALID",
    );
    // 受控内部码格式不符 → INTERNAL_ERROR（绝不原样持久化）
    expect(
      jobErrorCode(new PermanentJobFailure("bad code with spaces and secrets")),
    ).toBe("INTERNAL_ERROR");

    // 未知形状 → UNKNOWN
    expect(jobErrorCode(undefined)).toBe("UNKNOWN");
    expect(jobErrorCode({ code: 42 })).toBe("UNKNOWN");

    // outbox 与 job 共用同一实现（禁止漂移）
    expect(safeAsyncErrorCode).toBeTypeOf("function");
  });
});
