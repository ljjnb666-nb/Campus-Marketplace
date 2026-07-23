import { describe, expect, it, vi } from "vitest";

const { nextAuth, authOptions } = vi.hoisted(() => {
  const handler = vi.fn();
  const nextAuth = vi.fn(() => handler);
  return {
    nextAuth,
    authOptions: { pages: { signIn: "/login" } },
    handler,
  };
});

vi.mock("next-auth", () => ({
  default: nextAuth,
}));

vi.mock("@/lib/auth", () => ({
  authOptions,
}));

import { GET, POST } from "@/app/api/auth/[...nextauth]/route";

describe("auth route", () => {
  it("creates GET and POST handlers from NextAuth(authOptions)", () => {
    expect(nextAuth).toHaveBeenCalledWith(authOptions);
    expect(GET).toBe(POST);
  });
});
