import { afterEach, describe, expect, it } from "vitest";

import robots from "@/app/robots";

const originalNextAuthUrl = process.env.NEXTAUTH_URL;

afterEach(() => {
  if (originalNextAuthUrl === undefined) {
    delete process.env.NEXTAUTH_URL;
  } else {
    process.env.NEXTAUTH_URL = originalNextAuthUrl;
  }
});

describe("robots", () => {
  it("allows crawlers everywhere except private areas and links the sitemap", () => {
    process.env.NEXTAUTH_URL = "https://campus.example.com";

    const result = robots();

    expect(result.rules).toEqual([
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/my", "/messages", "/api", "/notifications"],
      },
    ]);
    expect(result.sitemap).toBe("https://campus.example.com/sitemap.xml");
  });

  it("falls back to the local address when NEXTAUTH_URL is missing", () => {
    delete process.env.NEXTAUTH_URL;

    expect(robots().sitemap).toBe("http://localhost:3000/sitemap.xml");
  });
});
