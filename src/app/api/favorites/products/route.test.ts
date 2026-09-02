import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, getMyFavoriteProducts } = vi.hoisted(() => ({
  auth: vi.fn(),
  getMyFavoriteProducts: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/repositories/product-repository", () => ({ getMyFavoriteProducts }));

import { GET } from "@/app/api/favorites/products/route";

describe("GET /api/favorites/products", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without a session", async () => {
    auth.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/favorites/products"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(getMyFavoriteProducts).not.toHaveBeenCalled();
  });

  it("returns favorites for the signed-in user", async () => {
    auth.mockResolvedValue({ user: { id: "user-1" } });
    getMyFavoriteProducts.mockResolvedValue([{ id: "fav-1" }]);

    const response = await GET(new Request("http://localhost/api/favorites/products"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ favorites: [{ id: "fav-1" }] });
    expect(getMyFavoriteProducts).toHaveBeenCalledWith("user-1");
  });

  it("maps repository errors to a 500 response", async () => {
    auth.mockResolvedValue({ user: { id: "user-1" } });
    getMyFavoriteProducts.mockRejectedValue(new Error("db down"));

    const response = await GET(new Request("http://localhost/api/favorites/products"));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(typeof body.error).toBe("string");
  });
});
