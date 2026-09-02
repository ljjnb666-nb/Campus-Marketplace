import { describe, expect, it } from "vitest";

import { getRequestId, runWithRequestId, withApiRequestContext } from "@/lib/request-context";

describe("request-context（TASK 1：服务端日志关联）", () => {
  it("withApiRequestContext 让回调内 getRequestId 返回同一 ID", async () => {
    const headers = new Headers({ "x-request-id": "valid-request-id" });

    await withApiRequestContext(headers, async () => {
      expect(getRequestId()).toBe("valid-request-id");
    });

    expect(getRequestId()).toBeUndefined();
  });

  it("header 缺失时按同一规则生成安全 ID", async () => {
    await withApiRequestContext(new Headers(), async () => {
      expect(getRequestId()).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  it("非法 ID 不透传，重新生成", async () => {
    const headers = new Headers({ "x-request-id": "bad id with spaces" });

    await withApiRequestContext(headers, async () => {
      expect(getRequestId()).toMatch(/^[0-9a-f]{32}$/);
      expect(getRequestId()).not.toBe("bad id with spaces");
    });
  });

  it("并发请求上下文互不串扰", async () => {
    await Promise.all([
      withApiRequestContext(new Headers({ "x-request-id": "request-aaaaaaaa" }), async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(getRequestId()).toBe("request-aaaaaaaa");
      }),
      withApiRequestContext(new Headers({ "x-request-id": "request-bbbbbbbb" }), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(getRequestId()).toBe("request-bbbbbbbb");
      }),
    ]);
  });

  it("runWithRequestId 供脚本场景使用", () => {
    const value = runWithRequestId("script-request-id", () => getRequestId());
    expect(value).toBe("script-request-id");
  });
});
