import { afterEach, describe, expect, it, vi } from "vitest";

const { getSitemapListings } = vi.hoisted(() => ({
  getSitemapListings: vi.fn(),
}));

vi.mock("@/repositories/sitemap-repository", () => ({
  getSitemapListings,
}));

import sitemap from "@/app/sitemap";

const originalNextAuthUrl = process.env.NEXTAUTH_URL;

afterEach(() => {
  vi.clearAllMocks();
  if (originalNextAuthUrl === undefined) {
    delete process.env.NEXTAUTH_URL;
  } else {
    process.env.NEXTAUTH_URL = originalNextAuthUrl;
  }
});

describe("sitemap", () => {
  it("lists static routes first with sensible priorities", async () => {
    process.env.NEXTAUTH_URL = "https://campus.example.com";
    getSitemapListings.mockResolvedValue({
      products: [],
      errands: [],
      services: [],
      rentals: [],
    });

    const entries = await sitemap();

    expect(entries.slice(0, 12)).toEqual([
      { url: "https://campus.example.com/", changeFrequency: "daily", priority: 1 },
      { url: "https://campus.example.com/products", changeFrequency: "daily", priority: 0.8 },
      { url: "https://campus.example.com/errands", changeFrequency: "daily", priority: 0.8 },
      { url: "https://campus.example.com/services", changeFrequency: "daily", priority: 0.8 },
      { url: "https://campus.example.com/rentals", changeFrequency: "daily", priority: 0.8 },
      { url: "https://campus.example.com/search", changeFrequency: "weekly", priority: 0.5 },
      { url: "https://campus.example.com/login", changeFrequency: "monthly", priority: 0.3 },
      { url: "https://campus.example.com/register", changeFrequency: "monthly", priority: 0.3 },
      // Phase 5：法务页面迁移为版本化 /legal/* 路由
      { url: "https://campus.example.com/legal/privacy", changeFrequency: "yearly", priority: 0.3 },
      { url: "https://campus.example.com/legal/rules", changeFrequency: "yearly", priority: 0.3 },
      { url: "https://campus.example.com/legal/terms", changeFrequency: "yearly", priority: 0.3 },
      { url: "https://campus.example.com/legal/prohibited", changeFrequency: "yearly", priority: 0.3 },
    ]);
  });

  it("appends active detail pages with their lastModified time", async () => {
    process.env.NEXTAUTH_URL = "https://campus.example.com";
    const updatedAt = new Date("2026-08-01T00:00:00.000Z");
    getSitemapListings.mockResolvedValue({
      products: [{ id: "product-1", updatedAt }],
      errands: [{ id: "errand-1", updatedAt }],
      services: [{ id: "service-1", updatedAt }],
      rentals: [{ id: "rental-1", updatedAt }],
    });

    const entries = await sitemap();

    expect(entries).toHaveLength(16);
    expect(entries.slice(12)).toEqual([
      {
        url: "https://campus.example.com/products/product-1",
        lastModified: updatedAt,
        changeFrequency: "weekly",
        priority: 0.7,
      },
      {
        url: "https://campus.example.com/errands/errand-1",
        lastModified: updatedAt,
        changeFrequency: "weekly",
        priority: 0.7,
      },
      {
        url: "https://campus.example.com/services/service-1",
        lastModified: updatedAt,
        changeFrequency: "weekly",
        priority: 0.7,
      },
      {
        url: "https://campus.example.com/rentals/rental-1",
        lastModified: updatedAt,
        changeFrequency: "weekly",
        priority: 0.7,
      },
    ]);
  });

  it("falls back to the local address when NEXTAUTH_URL is missing", async () => {
    delete process.env.NEXTAUTH_URL;
    getSitemapListings.mockResolvedValue({
      products: [],
      errands: [],
      services: [],
      rentals: [],
    });

    const entries = await sitemap();

    expect(entries[0].url).toBe("http://localhost:3000/");
  });
});
