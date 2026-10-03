import { describe, expect, it, vi } from "vitest";

import { PermanentJobFailure } from "@/lib/async/job-types";

import {
  EMAIL_IDEMPOTENCY_SAFE_WINDOW_MS,
  EMAIL_PROVIDER_TIMEOUT_MS_MAX,
  EMAIL_PROVIDER_TIMEOUT_MS_MIN,
  EmailRuntimeConfigUnavailableError,
  EmailTemplateContractError,
  extractEmailAddress,
  OFFICIAL_RESEND_BASE_URL,
  resolveEmailAppBaseUrl,
  resolveEmailChannelConfig,
  resolveEmailSendConfig,
} from "./email-config";
import { isEmailIdempotencyWindowExpired } from "./email-provider";
import { ResendEmailProvider } from "./providers/resend";
import { escapeHtml } from "./email-escape";
import {
  PRODUCT_RESERVATION_EXPIRED_KIND,
  resolveNotificationDefinition,
} from "./notification-registry";
import { renderNotificationEmail } from "./email-renderer";

/**
 * Phase 9B email slice unit contracts（§23-§45）：
 * - config 解析 fail closed（provider/baseUrl/timeout/origin 契约）；
 * - Resend provider 错误分类（§30 全表）+ timeout + 幂等键必带；
 * - 模板 HTML escaping（§40）+ 链接 origin（§41）；
 * - 幂等安全窗口判定（§26）。
 */

const VALID_ENV = {
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_unit_test_key_000000000001",
  EMAIL_FROM: "Campus <noreply@campus.test>",
  EMAIL_PROVIDER_TIMEOUT_MS: "10000",
};

function fetchOk(id = "msg-1"): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ id }), { status: 200 }),
  ) as unknown as typeof fetch;
}

function fetchStatus(status: number, body: string): typeof fetch {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe("email-config（§42/§44/§45/§41）", () => {
  it("resend：解析 from/replyTo（支持 Display Name 形态）", () => {
    const config = resolveEmailChannelConfig(VALID_ENV);
    expect(config).toEqual({ provider: "resend", from: "Campus <noreply@campus.test>", replyTo: null });
  });

  it("extractEmailAddress：addr 与 Display Name 两种形态；非法返回 null", () => {
    expect(extractEmailAddress("a@b.co")).toBe("a@b.co");
    expect(extractEmailAddress("Name <a@b.co>")).toBe("a@b.co");
    expect(extractEmailAddress("not-an-email")).toBeNull();
    expect(extractEmailAddress("")).toBeNull();
    expect(extractEmailAddress(undefined)).toBeNull();
  });

  it("disabled：非生产未设置 EMAIL_PROVIDER → disabled（0 provider call 配置）", () => {
    expect(resolveEmailChannelConfig({ NODE_ENV: "test" })).toEqual({
      provider: "disabled",
      from: null,
      replyTo: null,
    });
  });

  it("生产未设置 EMAIL_PROVIDER / resend 但 EMAIL_FROM 非法 → 受控配置错误", () => {
    expect(() => resolveEmailChannelConfig({ NODE_ENV: "production" })).toThrow(
      expect.objectContaining({ code: "EMAIL_PROVIDER_CONFIG_INVALID" }),
    );
    expect(() =>
      resolveEmailChannelConfig({ NODE_ENV: "test", EMAIL_PROVIDER: "resend", EMAIL_FROM: "bad" }),
    ).toThrow(expect.objectContaining({ code: "EMAIL_PROVIDER_CONFIG_INVALID" }));
  });

  it("RB03（§12/§13/§14）：config 不可用 = RETRYABLE 环境态；模板契约缺陷 = PERMANENT", () => {
    let caught: unknown;
    try {
      resolveEmailChannelConfig({ NODE_ENV: "test", EMAIL_PROVIDER: "resend", EMAIL_FROM: "bad" });
    } catch (error) {
      caught = error;
    }
    // runtime config 不可用：extends Error（classifyJobFailure → RETRYABLE），
    // 绝不继承 PermanentJobFailure
    expect(caught).toBeInstanceOf(EmailRuntimeConfigUnavailableError);
    expect((caught as Error).name).toBe("EmailRuntimeConfigUnavailableError");
    expect(caught as unknown).not.toBeInstanceOf(PermanentJobFailure);

    // 结构性模板契约缺陷：PERMANENT → DEAD_LETTER（禁止无限 retry）
    const template = new EmailTemplateContractError("EMAIL_TEMPLATE_UNREGISTERED", "x");
    expect(template).toBeInstanceOf(PermanentJobFailure);
    expect(template.failureClass).toBe("PERMANENT");
  });

  it("生产禁止覆盖 RESEND_API_BASE_URL（§45 防 SSRF/exfil）；非生产允许 fake URL", () => {
    expect(() =>
      resolveEmailSendConfig({
        NODE_ENV: "production",
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_ok_key_000000000001",
        RESEND_API_BASE_URL: "http://evil.example",
      }),
    ).toThrow(expect.objectContaining({ code: "EMAIL_PROVIDER_CONFIG_INVALID" }));

    const dev = resolveEmailSendConfig({
      NODE_ENV: "test",
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_ok_key_000000000001",
      RESEND_API_BASE_URL: "http://127.0.0.1:9555/",
    });
    expect(dev.baseUrl).toBe("http://127.0.0.1:9555");

    expect(
      resolveEmailSendConfig({ ...VALID_ENV, NODE_ENV: "production" }).baseUrl,
    ).toBe(OFFICIAL_RESEND_BASE_URL);
  });

  it("API key 缺失/占位值拒绝；timeout 越界拒绝、未设置取默认", () => {
    expect(() =>
      resolveEmailSendConfig({ NODE_ENV: "test", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "" }),
    ).toThrow(expect.objectContaining({ code: "EMAIL_PROVIDER_CONFIG_INVALID" }));
    expect(() =>
      resolveEmailSendConfig({
        NODE_ENV: "test",
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "changeme-key",
      }),
    ).toThrow(expect.objectContaining({ code: "EMAIL_PROVIDER_CONFIG_INVALID" }));
    expect(() =>
      resolveEmailSendConfig({ ...VALID_ENV, EMAIL_PROVIDER_TIMEOUT_MS: "500" }),
    ).toThrow(expect.objectContaining({ code: "EMAIL_PROVIDER_CONFIG_INVALID" }));
    expect(() =>
      resolveEmailSendConfig({ ...VALID_ENV, EMAIL_PROVIDER_TIMEOUT_MS: String(EMAIL_PROVIDER_TIMEOUT_MS_MAX + 1) }),
    ).toThrow(expect.objectContaining({ code: "EMAIL_PROVIDER_CONFIG_INVALID" }));
    expect(
      resolveEmailSendConfig({ NODE_ENV: "test", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_ok_000000000001" })
        .timeoutMs,
    ).toBe(10_000);
    expect(EMAIL_PROVIDER_TIMEOUT_MS_MIN).toBe(1_000);
  });

  it("邮件链接 origin：唯一来源 NEXTAUTH_URL；生产必须 https", () => {
    expect(resolveEmailAppBaseUrl({ NODE_ENV: "test", NEXTAUTH_URL: "http://localhost:3000/" })).toBe(
      "http://localhost:3000",
    );
    expect(() => resolveEmailAppBaseUrl({ NODE_ENV: "test" })).toThrow(
      expect.objectContaining({ code: "EMAIL_LINK_ORIGIN_INVALID" }),
    );
    expect(() =>
      resolveEmailAppBaseUrl({ NODE_ENV: "production", NEXTAUTH_URL: "http://campus.example" }),
    ).toThrow(expect.objectContaining({ code: "EMAIL_LINK_ORIGIN_INVALID" }));
  });
});

describe("ResendEmailProvider（§24/§25/§29/§30）", () => {
  const REQUEST = {
    idempotencyKey: "notification/n1/email/v1",
    from: "Campus <noreply@campus.test>",
    to: "rcpt@campus.test",
    replyTo: null,
    subject: "商品预留已过期",
    text: "text",
    html: "<p>html</p>",
  };

  function makeProvider(fetchImpl: typeof fetch, timeoutMs = 10_000) {
    return new ResendEmailProvider({
      apiKey: "re_key",
      baseUrl: "http://resend.test",
      timeoutMs,
      fetchImpl,
    });
  }

  it("2xx → providerMessageId；请求携带 Idempotency-Key + Bearer + 有界 signal", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Idempotency-Key")).toBe("notification/n1/email/v1");
      expect(headers.get("Authorization")).toBe("Bearer re_key");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ id: "re_msg_9" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await makeProvider(fetchImpl).sendTransactionalEmail(REQUEST);
    expect(result).toEqual({ providerMessageId: "re_msg_9" });
  });

  it("分类表：429/5xx/409 concurrent → RETRYABLE（EmailProviderRetryableError）", async () => {
    for (const [status, body] of [
      [429, "{}"],
      [502, "{}"],
      [409, '{"name":"concurrent_idempotent_requests"}'],
    ] as const) {
      await expect(
        makeProvider(fetchStatus(status, body)).sendTransactionalEmail(REQUEST),
      ).rejects.toMatchObject({ name: "EmailProviderRetryableError" });
    }
  });

  it("分类表：409 invalid / 400 / 401 / 403 / 其它 4xx → PERMANENT（立即 dead-letter 类）", async () => {
    for (const [status, body] of [
      [409, '{"name":"invalid_idempotent_request"}'],
      [400, "{}"],
      [401, "{}"],
      [403, "{}"],
      [418, "{}"],
    ] as const) {
      await expect(
        makeProvider(fetchStatus(status, body)).sendTransactionalEmail(REQUEST),
      ).rejects.toMatchObject({ name: "EmailProviderPermanentError" });
    }
  });

  it("abort/timeout → RETRYABLE EMAIL_PROVIDER_TIMEOUT；网络错误 → RETRYABLE NETWORK", async () => {
    const timeoutFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted due to timeout");
          error.name = "TimeoutError";
          reject(error);
        });
      });
    }) as unknown as typeof fetch;
    await expect(
      makeProvider(timeoutFetch, 20).sendTransactionalEmail(REQUEST),
    ).rejects.toMatchObject({ code: "EMAIL_PROVIDER_TIMEOUT" });

    const networkFetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      makeProvider(networkFetch).sendTransactionalEmail(REQUEST),
    ).rejects.toMatchObject({ code: "EMAIL_PROVIDER_NETWORK" });
  });

  it("缺少幂等键 → PERMANENT（provider 绝不自行生成随机 key，§25）", async () => {
    await expect(
      makeProvider(fetchOk()).sendTransactionalEmail({ ...REQUEST, idempotencyKey: "" }),
    ).rejects.toMatchObject({ name: "EmailProviderPermanentError" });
  });

  it("错误对象绝不携带 provider raw body / API key（§31）", async () => {
    const rawBody = '{"message":"secret-context rcpt@campus.test Bearer re_key"}';
    let caught: unknown;
    try {
      await makeProvider(fetchStatus(400, rawBody)).sendTransactionalEmail(REQUEST);
    } catch (error) {
      caught = error;
    }
    const error = caught as Error;
    expect(JSON.stringify(error)).not.toContain("secret-context");
    expect(JSON.stringify(error)).not.toContain("Bearer");
    expect(JSON.stringify(error)).not.toContain("re_key");
  });
});

describe("email renderer（§38/§39/§40/§41）", () => {
  const PAYLOAD = { orderId: "o1", buyerId: "buyer-1", sellerId: "seller-1" };

  function renderFor(recipient: string, baseUrl: string) {
    return renderNotificationEmail(
      { kind: PRODUCT_RESERVATION_EXPIRED_KIND, schemaVersion: 1, payload: PAYLOAD },
      recipient,
      baseUrl,
    );
  }

  it("PRODUCT_RESERVATION_EXPIRED@1 开通 EMAIL 渠道且 renderEmail 已注册", () => {
    const definition = resolveNotificationDefinition(PRODUCT_RESERVATION_EXPIRED_KIND, 1);
    expect(definition?.channels).toContain("EMAIL");
    expect(definition?.renderEmail).toBeTypeOf("function");
  });

  it("渲染包含 subject/plain text/HTML 三件套，双角色固定中文文案", () => {
    for (const recipient of ["buyer-1", "seller-1"]) {
      const rendered = renderFor(recipient, "https://campus.example");
      expect(rendered.subject.length).toBeGreaterThan(0);
      expect(rendered.text).toContain("https://campus.example/my/orders");
      expect(rendered.html).toContain("https://campus.example/my/orders");
      expect(rendered.text).not.toContain("<p>");
      expect(rendered.html).toContain("<");
    }
  });

  it("HTML escaping：& < > \" ' 全部转义，无法形成 injection（§40）", () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;",
    );
    const hostileBase = 'https://campus.example"><script>alert(1)</script>';
    const rendered = renderFor("buyer-1", hostileBase);
    expect(rendered.html).not.toContain('"><script>');
    expect(rendered.html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("registry 入口：未开通 EMAIL 渠道的 kind → 结构性拒绝", () => {
    expect(() =>
      renderNotificationEmail(
        { kind: "ORDER_STATUS_CHANGED", schemaVersion: 1, payload: { orderId: "o", status: "ACCEPTED", actorRole: "BUYER" } },
        "u1",
        "https://campus.example",
      ),
    ).toThrow(expect.objectContaining({ code: "EMAIL_TEMPLATE_UNREGISTERED" }));
  });
});

describe("idempotency window（§26）", () => {
  it("firstAttemptAt + 23h 内允许 retry；超窗 fail closed", () => {
    const first = new Date("2026-10-01T00:00:00Z");
    expect(isEmailIdempotencyWindowExpired(first, new Date(first.getTime() + EMAIL_IDEMPOTENCY_SAFE_WINDOW_MS - 1), EMAIL_IDEMPOTENCY_SAFE_WINDOW_MS)).toBe(false);
    expect(isEmailIdempotencyWindowExpired(first, new Date(first.getTime() + EMAIL_IDEMPOTENCY_SAFE_WINDOW_MS), EMAIL_IDEMPOTENCY_SAFE_WINDOW_MS)).toBe(true);
  });
});
