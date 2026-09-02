import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, getMyRentalFavorites } = vi.hoisted(() => ({
  auth: vi.fn(),
  getMyRentalFavorites: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/actions/rental-favorite", () => ({ getMyRentalFavorites }));

import { GET } from "@/app/api/favorites/rentals/route";

describe("GET /api/favorites/rentals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without a session", async () => {
    auth.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/favorites/rentals"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(getMyRentalFavorites).not.toHaveBeenCalled();
  });

  it("returns favorites for the signed-in user", async () => {
    auth.mockResolvedValue({ user: { id: "user-1" } });
    getMyRentalFavorites.mockResolvedValue([{ id: "fav-1" }]);

    const response = await GET(new Request("http://localhost/api/favorites/rentals"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ favorites: [{ id: "fav-1" }] });
    expect(getMyRentalFavorites).toHaveBeenCalledWith("user-1");
  });

  it("maps repository errors to a 500 response", async () => {
    auth.mockResolvedValue({ user: { id: "user-1" } });
    getMyRentalFavorites.mockRejectedValue(new Error("db down"));

    const response = await GET(new Request("http://localhost/api/favorites/rentals"));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(typeof body.error).toBe("string");
  });
});
