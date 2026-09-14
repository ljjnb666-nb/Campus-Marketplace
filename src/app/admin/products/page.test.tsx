import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAdmin, redirect } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  requireAdmin,
}));
vi.mock("next/navigation", () => ({
  redirect,
}));

import AdminProductsPage from "./page";

afterEach(cleanup);

describe("AdminProductsPage (Phase 7C legacy delegation)", () => {
  it("redirects to the governance listings surface", async () => {
    requireAdmin.mockResolvedValue({ id: "admin-1" });
    redirect.mockReturnValue(undefined as never);

    const element = await AdminProductsPage();
    void element;

    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/governance/listings");
  });
});
