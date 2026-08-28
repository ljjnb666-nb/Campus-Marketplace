import { describe, expect, it, vi } from "vitest";

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_client: unknown, command: unknown, options: { expiresIn: number }) =>
    `http://localhost:9100/signed?expires=${options.expiresIn}&key=${
      (command as { input: { Key: string } }).input.Key
    }`,
  ),
}));

import { S3Storage } from "@/lib/storage/s3-storage";

/** S3Client 桩：记录发送的命令并按场景返回 */
function buildFakeClient(handler: (commandName: string, input: Record<string, unknown>) => unknown) {
  return {
    send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) =>
      handler(command.constructor.name, command.input),
    ),
  } as unknown as ConstructorParameters<typeof S3Storage>[0];
}

const ref = { bucket: "campus-private", objectKey: "private/verification/u1/a.webp" };

describe("S3Storage", () => {
  it("rejects malformed bucket names before touching the SDK", async () => {
    const storage = new S3Storage(buildFakeClient(() => ({})));
    const client = storage as unknown as { client: { send: ReturnType<typeof vi.fn> } };

    await expect(
      storage.putObject({
        ...ref,
        bucket: "BAD_BUCKET!",
        body: Buffer.alloc(1),
        contentType: "image/webp",
        cacheControl: "private, no-store",
      }),
    ).rejects.toThrow("bucket");
    expect(client.client.send).not.toHaveBeenCalled();
  });

  it("rejects object keys with traversal shapes before touching the SDK", async () => {
    const storage = new S3Storage(buildFakeClient(() => ({})));
    const client = storage as unknown as { client: { send: ReturnType<typeof vi.fn> } };

    await expect(
      storage.deleteObject({ bucket: "campus-private", objectKey: "../etc/passwd" }),
    ).rejects.toThrow("object key");
    await expect(
      storage.headObject({ bucket: "campus-private", objectKey: "a\\b\\c.webp" }),
    ).rejects.toThrow("object key");
    expect(client.client.send).not.toHaveBeenCalled();
  });

  it("puts objects with the caller-provided cache policy verbatim", async () => {
    const storage = new S3Storage(buildFakeClient(() => ({})));

    await storage.putObject({
      ...ref,
      body: Buffer.alloc(4),
      contentType: "image/webp",
      // 私有对象策略必须原样透传（public 缓存策略绝不能出现在私有对象上）
      cacheControl: "private, no-store",
    });

    const client = storage as unknown as { client: { send: ReturnType<typeof vi.fn> } };
    const input = client.client.send.mock.calls[0][0].input;
    expect(input.Bucket).toBe("campus-private");
    expect(input.Key).toBe(ref.objectKey);
    expect(input.ContentType).toBe("image/webp");
    expect(input.CacheControl).toBe("private, no-store");
  });

  it("signs read urls with an optional response cache-control override", async () => {
    const storage = new S3Storage(buildFakeClient(() => ({})));

    const url = await storage.getSignedReadUrl(ref, 300, "private, no-store");

    expect(url).toContain("expires=300");
    expect(url).toContain(`key=${ref.objectKey}`);
  });

  it("maps missing objects from headObject to null", async () => {
    const storage = new S3Storage(
      buildFakeClient(() => {
        const error = new Error("NoSuchKey") as Error & {
          $metadata: { httpStatusCode: number };
        };
        error.name = "NotFound";
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }),
    );

    await expect(storage.headObject(ref)).resolves.toBeNull();
  });

  it("returns metadata for existing objects", async () => {
    const storage = new S3Storage(
      buildFakeClient((commandName) =>
        commandName === "HeadObjectCommand"
          ? { ContentLength: 2048, ContentType: "image/webp" }
          : {},
      ),
    );

    await expect(storage.headObject(ref)).resolves.toEqual({
      sizeBytes: 2048,
      contentType: "image/webp",
    });
  });

  it("propagates non-404 head errors", async () => {
    const storage = new S3Storage(
      buildFakeClient(() => {
        const error = new Error("slow down") as Error & {
          $metadata: { httpStatusCode: number };
        };
        error.$metadata = { httpStatusCode: 503 };
        throw error;
      }),
    );

    await expect(storage.headObject(ref)).rejects.toThrow("slow down");
  });
});
