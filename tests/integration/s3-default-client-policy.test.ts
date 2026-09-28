import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";

import {
  S3_CONNECT_TIMEOUT_MS,
  S3_MAX_ATTEMPTS,
  S3_REQUEST_TIMEOUT_MS,
  S3_SOCKET_TIMEOUT_MS,
} from "@/lib/storage/s3-client-policy";

/**
 * LR-R3：生产默认构造路径（getStorage → new S3Storage()）必须携带有界
 * 传输契约。本文件在动态 import s3-storage / env 之前注入 S3_ENDPOINT，
 * 对健康 fake S3 完成一次真实请求，再读取 client 已解析配置断言：
 * maxAttempts / retryMode / requestHandler 超时全部来自
 * createBoundedS3Client（而非 SDK 默认值）。
 */

function startHealthyS3() {
  const server = net.createServer((socket) => {
    let responded = false;
    socket.on("data", () => {
      if (responded) return;
      responded = true;
      socket.end(
        [
          "HTTP/1.1 200 OK",
          "x-amz-request-id: FAKE-REQUEST-ID",
          "content-type: application/xml",
          "content-length: 0",
          "connection: close",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("error", () => undefined);
  });
  return new Promise<{ server: net.Server; port: number }>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
    server.on("error", reject);
  });
}

describe("S3Storage 默认构造 = 有界传输契约（生产 wiring）", () => {
  let server: net.Server;
  let port: number;

  beforeAll(async () => {
    const started = await startHealthyS3();
    server = started.server;
    port = started.port;
    // 必须在 import（触发 env 解析）之前注入
    process.env.S3_ENDPOINT = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server?.close();
  });

  it("默认构造的 S3Client 携带 createBoundedS3Client 的全部传输预算", async () => {
    const { S3Storage } = await import("@/lib/storage/s3-storage");

    const storage = new S3Storage();
    const client = (storage as unknown as { client: import("@aws-sdk/client-s3").S3Client })
      .client;
    const config = client.config as unknown as Record<string, unknown>;
    const resolve = async (value: unknown) =>
      typeof value === "function" ? await (value as () => unknown)() : value;

    expect(await resolve(config.maxAttempts)).toBe(S3_MAX_ATTEMPTS);
    expect(await resolve(config.retryMode)).toBe("standard");

    const handler = (await resolve(config.requestHandler)) as {
      httpHandlerConfigs?: () => Record<string, unknown>;
    };
    // NodeHttpHandler 惰性解析：首次真实请求后 httpHandlerConfigs 才生效
    await storage.putObject({
      bucket: "campus-public",
      objectKey: "public/product/u-wiring/x.webp",
      body: Buffer.alloc(32),
      contentType: "image/webp",
      cacheControl: "private, no-store",
    });

    const handlerConfig = handler.httpHandlerConfigs?.() ?? {};
    expect(handlerConfig.connectionTimeout).toBe(S3_CONNECT_TIMEOUT_MS);
    expect(handlerConfig.socketTimeout).toBe(S3_SOCKET_TIMEOUT_MS);
    expect(handlerConfig.requestTimeout).toBe(S3_REQUEST_TIMEOUT_MS);
    expect(handlerConfig.throwOnRequestTimeout).toBe(true);
  }, 15_000);
});
