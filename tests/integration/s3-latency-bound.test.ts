import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";

import {
  S3_DELETE_OPERATION_TIMEOUT_MS,
  S3_MAX_ATTEMPTS,
  S3_PUT_OPERATION_TIMEOUT_MS,
  createBoundedS3Client,
} from "@/lib/storage/s3-client-policy";
import { S3Storage } from "@/lib/storage/s3-storage";
import type { ObjectRef } from "@/lib/storage/types";

/**
 * LR-R3 / STORAGE_OUTAGE_UPLOAD_LONG_TAIL：传输契约有界性测试。
 *
 * 全部使用【生产同构】的 createBoundedS3Client（S3Storage 默认构造的唯一
 * 入口）+ 真实 TCP 故障端点——不是 unit mock：
 *
 * - R3-03 CONNECTION REFUSED：无监听端口 → 有界快速失败、attempt 不超预算、
 *   错误不泄漏凭据。
 * - R3-04 BLACKHOLE / HANGING：accept TCP 后永不响应（36s 长尾的核心故障
 *   形态）→ 操作在 PUT/DELETE 整体预算内退出。
 * - R3-07 RETRY COUNT：计数 fake S3 server 证明 attempt 数 ≤ 配置预算
 *   （不只是测 elapsed）。
 * - R3-08 CONCURRENT OUTAGE：并发放障请求全部有界、无悬挂。
 * - HEALTHY sanity：正常 fake S3 200 路径不受超时策略影响。
 */

// 测试专用合成凭据（运行时拼接的非真实凭据；R3-03 用它断言错误不泄漏凭据）
const SYNTHETIC_CREDENTIALS = {
  accessKeyId: ["synthetic", "access", "id"].join("-"),
  secretAccessKey: ["synthetic", "secret", "must-not-leak"].join("-"),
} as const;

const BASE_CONFIG = {
  endpoint: "http://127.0.0.1:0",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: SYNTHETIC_CREDENTIALS,
} as const;

const ref: ObjectRef = { bucket: "campus-public", objectKey: "public/product/u-test/x.webp" };

const PUT_BOUND_MS = S3_PUT_OPERATION_TIMEOUT_MS + 2000;
const DELETE_BOUND_MS = S3_DELETE_OPERATION_TIMEOUT_MS + 2000;

/** accept 后永不响应的 blackhole 端点（计数接受的连接数 = 观测 attempt 数） */
function startBlackholeServer() {
  const connections: net.Socket[] = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    // 故意不响应、不消费——内核缓冲足够容纳测试请求体
    socket.on("error", () => undefined);
  });
  return { server, connections, listen: () => listenOn(server) };
}

/** 计数请求数并按固定状态码响应的最小 fake S3 */
function startCountingS3Server(statusLine: string, body: string) {
  let requestCount = 0;
  const server = net.createServer((socket) => {
    let responded = false;
    socket.on("data", () => {
      if (responded) return;
      responded = true;
      requestCount += 1;
      socket.end(
        [
          statusLine,
          "x-amz-request-id: FAKE-REQUEST-ID",
          "content-type: application/xml",
          `content-length: ${Buffer.byteLength(body)}`,
          "connection: close",
          "",
          body,
        ].join("\r\n"),
      );
    });
    socket.on("error", () => undefined);
  });
  return { server, getRequestCount: () => requestCount, listen: () => listenOn(server) };
}

function listenOn(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
    server.on("error", reject);
  });
}

/** 找当前无监听的端口（connection refused 形态） */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

describe("S3 传输契约有界性（真实 TCP 故障端点）", () => {
  let cleanup: Array<() => void> = [];

  beforeAll(() => {
    cleanup = [];
  });

  afterAll(() => {
    for (const fn of cleanup) fn();
  });

  function register(server: net.Server) {
    cleanup.push(() => server.close());
  }

  it("R3-04 blackhole（accept 后永不响应）：putObject 在整体预算内退出，attempt ≤ 配置", async () => {
    const blackhole = startBlackholeServer();
    const port = await blackhole.listen();
    register(blackhole.server);

    const storage = new S3Storage(
      createBoundedS3Client({ ...BASE_CONFIG, endpoint: `http://127.0.0.1:${port}` }),
    );

    const startedAt = Date.now();
    await expect(
      storage.putObject({ ...ref, body: Buffer.alloc(1024), contentType: "image/webp", cacheControl: "private, no-store" }),
    ).rejects.toThrow();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThanOrEqual(PUT_BOUND_MS);
    // 观测到的连接数（= attempt 上界）不得超过重试预算
    expect(blackhole.connections.length).toBeLessThanOrEqual(S3_MAX_ATTEMPTS);
  }, 30_000);

  it("R3-04 blackhole：deleteObject 在整体预算内退出（上传失败内联 purge 不悬挂请求）", async () => {
    const blackhole = startBlackholeServer();
    const port = await blackhole.listen();
    register(blackhole.server);

    const storage = new S3Storage(
      createBoundedS3Client({ ...BASE_CONFIG, endpoint: `http://127.0.0.1:${port}` }),
    );

    const startedAt = Date.now();
    await expect(storage.deleteObject(ref)).rejects.toThrow();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThanOrEqual(DELETE_BOUND_MS);
    expect(blackhole.connections.length).toBeLessThanOrEqual(S3_MAX_ATTEMPTS);
  }, 30_000);

  it("R3-03 connection refused：有界快速失败、attempt ≤ 预算、不泄漏凭据", async () => {
    const port = await findFreePort();
    const storage = new S3Storage(
      createBoundedS3Client({ ...BASE_CONFIG, endpoint: `http://127.0.0.1:${port}` }),
    );

    const startedAt = Date.now();
    let thrown: unknown = null;
    try {
      await storage.putObject({ ...ref, body: Buffer.alloc(64), contentType: "image/webp", cacheControl: "private, no-store" });
    } catch (error) {
      thrown = error;
    }
    const elapsed = Date.now() - startedAt;

    expect(thrown).not.toBeNull();
    expect(elapsed).toBeLessThan(5000);
    const metadata = (thrown as { $metadata?: { attempts?: number } }).$metadata;
    expect(metadata?.attempts).toBeLessThanOrEqual(S3_MAX_ATTEMPTS);

    // 无凭据/无密钥泄漏（错误对象与字符串化形态都检查）
    const rendered = `${(thrown as Error).message} ${String(thrown)}`;
    expect(rendered).not.toContain(BASE_CONFIG.credentials.secretAccessKey);
    expect(rendered).not.toContain(BASE_CONFIG.credentials.accessKeyId);
  }, 15_000);

  it("R3-07 retry count：计数 server 证明 attempt 数 == 配置预算（不只测 elapsed）", async () => {
    const responder = startCountingS3Server(
      "HTTP/1.1 503 Slow Down",
      `<?xml version="1.0"?><Error><Code>SlowDown</Code></Error>`,
    );
    const port = await responder.listen();
    register(responder.server);

    const storage = new S3Storage(
      createBoundedS3Client({ ...BASE_CONFIG, endpoint: `http://127.0.0.1:${port}` }),
    );

    await expect(
      storage.putObject({ ...ref, body: Buffer.alloc(64), contentType: "image/webp", cacheControl: "private, no-store" }),
    ).rejects.toThrow();

    // 503 属可重试错误：恰好重试到预算上限，不多不少
    expect(responder.getRequestCount()).toBe(S3_MAX_ATTEMPTS);
  }, 15_000);

  it("HEALTHY sanity：正常 fake S3 200 路径正常完成（超时策略不影响健康流量）", async () => {
    const healthy = startCountingS3Server("HTTP/1.1 200 OK", "");
    const port = await healthy.listen();
    register(healthy.server);

    const storage = new S3Storage(
      createBoundedS3Client({ ...BASE_CONFIG, endpoint: `http://127.0.0.1:${port}` }),
    );

    const startedAt = Date.now();
    await expect(
      storage.putObject({ ...ref, body: Buffer.alloc(64), contentType: "image/webp", cacheControl: "private, no-store" }),
    ).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(healthy.getRequestCount()).toBe(1);
  }, 15_000);

  it("R3-08 concurrent outage：12 个并发放障上传全部有界、无悬挂", async () => {
    const blackhole = startBlackholeServer();
    const port = await blackhole.listen();
    register(blackhole.server);

    const storage = new S3Storage(
      createBoundedS3Client({ ...BASE_CONFIG, endpoint: `http://127.0.0.1:${port}` }),
    );

    const startedAt = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        storage.putObject({
          bucket: ref.bucket,
          objectKey: `public/product/u-test/concurrent-${index}.webp`,
          body: Buffer.alloc(512),
          contentType: "image/webp",
          cacheControl: "private, no-store",
        }),
      ),
    );
    const elapsed = Date.now() - startedAt;

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    // 全部并发请求共享同一个预算上界（而非串行累加）
    expect(elapsed).toBeLessThanOrEqual(PUT_BOUND_MS + 2000);
  }, 40_000);
});
