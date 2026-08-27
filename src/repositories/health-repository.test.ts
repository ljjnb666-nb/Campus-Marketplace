import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryRaw } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: queryRaw,
  },
}));

import { pingDatabase } from "@/repositories/health-repository";

describe("pingDatabase", () => {
  beforeEach(() => {
    queryRaw.mockReset();
  });

  it("issues a SELECT 1 probe and resolves on success", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);

    await expect(pingDatabase()).resolves.toBeUndefined();

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("propagates connection failures to the caller", async () => {
    queryRaw.mockRejectedValue(new Error("connection refused"));

    await expect(pingDatabase()).rejects.toThrow("connection refused");
  });
});
