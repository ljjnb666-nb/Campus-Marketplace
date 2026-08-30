import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, readPrivateAssetObject } = vi.hoisted(() => ({
  auth: vi.fn(),
  readPrivateAssetObject: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/asset-service", () => ({ readPrivateAssetObject }));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/assets/[assetId]/content/route";

const FIXTURE_BODY = Buffer.from("fixture-bytes");

function callGet(assetId = "asset-1") {
  return GET(new Request(`http://localhost:3000/api/assets/${assetId}/content`), {
    params: Promise.resolve({ assetId }),
  });
}

describe("GET /api/assets/[assetId]/content（私有资产同源代理）", () => {
  beforeEach(() => {
    auth.mockReset().mockResolvedValue({ user: { id: "user-1", role: "STUDENT" } });
    readPrivateAssetObject.mockReset();
  });

  it("returns 401 for anonymous requests（独立鉴权，不依赖 access API）", async () => {
    auth.mockResolvedValue(null);

    const response = await callGet();

    expect(response.status).toBe(401);
    expect(readPrivateAssetObject).not.toHaveBeenCalled();
  });

  it("streams the object with trusted metadata and private no-store headers", async () => {
    readPrivateAssetObject.mockResolvedValue({
      ok: true,
      body: FIXTURE_BODY,
      contentType: "image/jpeg",
      sizeBytes: FIXTURE_BODY.byteLength,
    });

    const response = await callGet();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-length")).toBe(String(FIXTURE_BODY.byteLength));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe("inline");
    await expect(response.arrayBuffer()).resolves.toEqual(
      FIXTURE_BODY.buffer.slice(FIXTURE_BODY.byteOffset, FIXTURE_BODY.byteOffset + FIXTURE_BODY.byteLength),
    );
    // 鉴权必须真实执行（服务端授权在本端点重新进行）
    expect(readPrivateAssetObject).toHaveBeenCalledWith("asset-1", {
      id: "user-1",
      role: "STUDENT",
    });
  });

  it("falls back to application/octet-stream when object metadata is missing", async () => {
    readPrivateAssetObject.mockResolvedValue({
      ok: true,
      body: FIXTURE_BODY,
      contentType: null,
      sizeBytes: FIXTURE_BODY.byteLength,
    });

    const response = await callGet();

    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("returns 404 for missing/deleted objects without leaking storage details", async () => {
    readPrivateAssetObject.mockResolvedValue({ ok: false, reason: "not_found" });

    const response = await callGet();
    const text = await response.text();

    expect(response.status).toBe(404);
    expect(text).not.toContain("campus-private");
    expect(text).not.toContain("minio");
    expect(text).not.toContain(":9000");
  });

  it("returns 403 for unrelated authenticated users and 410 for expired assets", async () => {
    readPrivateAssetObject.mockResolvedValue({ ok: false, reason: "forbidden" });
    expect((await callGet()).status).toBe(403);

    readPrivateAssetObject.mockResolvedValue({ ok: false, reason: "expired" });
    expect((await callGet()).status).toBe(410);
  });

  it("maps unexpected failures to 500 without internals", async () => {
    readPrivateAssetObject.mockRejectedValue(new Error("s3 exploded: bucket=key"));

    const response = await callGet();
    const body = (await response.json()) as { message?: string };

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("bucket");
    expect(JSON.stringify(body)).not.toContain("minio");
    expect(body).toEqual({ message: "资源访问失败，请稍后重试" });
  });
});
