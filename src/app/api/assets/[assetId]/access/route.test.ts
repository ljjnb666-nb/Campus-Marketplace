import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, resolvePrivateAssetAccess, resolvePublicAssetUrl } = vi.hoisted(() => ({
  auth: vi.fn(),
  resolvePrivateAssetAccess: vi.fn(),
  resolvePublicAssetUrl: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));

vi.mock("@/lib/asset-service", () => ({
  resolvePrivateAssetAccess,
  resolvePublicAssetUrl,
}));

import { GET } from "@/app/api/assets/[assetId]/access/route";

function buildRequest(assetId = "asset-1") {
  return new Request(`http://localhost:3000/api/assets/${assetId}/access`, {
    method: "GET",
  });
}

function callGet(assetId = "asset-1") {
  return GET(buildRequest(assetId), {
    params: Promise.resolve({ assetId }),
  });
}

describe("GET /api/assets/[assetId]/access", () => {
  beforeEach(() => {
    auth.mockReset().mockResolvedValue({ user: { id: "user-1", role: "STUDENT" } });
    resolvePrivateAssetAccess.mockReset();
    resolvePublicAssetUrl.mockReset();
  });

  it("returns 401 for anonymous requests", async () => {
    auth.mockResolvedValue(null);

    const response = await callGet();

    expect(response.status).toBe(401);
    expect(resolvePrivateAssetAccess).not.toHaveBeenCalled();
  });

  it("returns a same-origin content proxy url for the asset owner (no internal endpoint leak)", async () => {
    resolvePrivateAssetAccess.mockResolvedValue({
      ok: true,
      asset: {
        bucket: "campus-private",
        objectKey: "private/verification/u1/x.webp",
        category: "VERIFICATION",
      },
    });

    const response = await callGet();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.url).toBe("/api/assets/asset-1/content");
    expect(body.access).toBe("PRIVATE");
    // 不得再返回对象存储签名 URL / 内部端点 / 桶名（self-hosted 下浏览器不可达）
    expect(body.url).not.toContain("minio");
    expect(body.url).not.toContain("campus-private");
    expect(body.url).not.toContain(":9000");
    expect(body).not.toHaveProperty("expiresIn");
  });

  it("keeps the same-origin proxy contract for admins", async () => {
    auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    resolvePrivateAssetAccess.mockResolvedValue({
      ok: true,
      asset: { bucket: "campus-private", objectKey: "private/report/u2/y.webp", category: "REPORT" },
    });

    const response = await callGet();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      url: "/api/assets/asset-1/content",
      access: "PRIVATE",
    });
  });

  it("hides existence with 404 for missing or deleted assets", async () => {
    resolvePrivateAssetAccess.mockResolvedValue({ ok: false, reason: "not_found" });

    const response = await callGet();

    expect(response.status).toBe(404);
  });

  it("returns 403 for strangers", async () => {
    resolvePrivateAssetAccess.mockResolvedValue({ ok: false, reason: "forbidden" });

    const response = await callGet();

    expect(response.status).toBe(403);
  });

  it("returns 410 when the retention window has expired", async () => {
    resolvePrivateAssetAccess.mockResolvedValue({ ok: false, reason: "expired" });

    const response = await callGet();

    expect(response.status).toBe(410);
  });

  it("returns the public url for public assets", async () => {
    resolvePrivateAssetAccess.mockResolvedValue({ ok: false, reason: "not_private" });
    resolvePublicAssetUrl.mockResolvedValue(
      "http://localhost:9100/campus-public/public/products/u/a.webp",
    );

    const response = await callGet();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "http://localhost:9100/campus-public/public/products/u/a.webp",
      access: "PUBLIC",
    });
  });

  it("returns 404 when a public asset lookup finds nothing alive", async () => {
    resolvePrivateAssetAccess.mockResolvedValue({ ok: false, reason: "not_private" });
    resolvePublicAssetUrl.mockResolvedValue(null);

    const response = await callGet();

    expect(response.status).toBe(404);
  });

  it("maps unexpected failures to 500 without internals", async () => {
    resolvePrivateAssetAccess.mockRejectedValue(new Error("boom"));

    const response = await callGet();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ message: "资源访问失败，请稍后重试" });
  });
});
