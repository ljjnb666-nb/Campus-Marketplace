import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyFavoriteToggle } from "@/lib/favorite-toggle";

function p2002Error() {
  return Object.assign(new Error("Unique constraint failed on the fields: (`userId`,`productId`)"), {
    code: "P2002",
  });
}

describe("applyFavoriteToggle", () => {
  const deleteFavorite = vi.fn();
  const createFavorite = vi.fn();
  const decrementCount = vi.fn();
  const incrementCount = vi.fn();

  function run() {
    return applyFavoriteToggle({
      deleteFavorite,
      createFavorite,
      decrementCount,
      incrementCount,
    });
  }

  beforeEach(() => {
    deleteFavorite.mockReset().mockResolvedValue({ count: 1 });
    createFavorite.mockReset().mockResolvedValue({ id: "favorite-1" });
    decrementCount.mockReset().mockResolvedValue({});
    incrementCount.mockReset().mockResolvedValue({});
  });

  it("removes the favorite and decrements the counter when a row is deleted", async () => {
    const result = await run();

    expect(result).toEqual({ success: true, isFavorited: false });
    expect(deleteFavorite).toHaveBeenCalledTimes(1);
    expect(decrementCount).toHaveBeenCalledTimes(1);
    expect(createFavorite).not.toHaveBeenCalled();
    expect(incrementCount).not.toHaveBeenCalled();
  });

  it("adds the favorite and increments the counter when nothing was deleted", async () => {
    deleteFavorite.mockResolvedValue({ count: 0 });

    const result = await run();

    expect(result).toEqual({ success: true, isFavorited: true });
    expect(createFavorite).toHaveBeenCalledTimes(1);
    expect(incrementCount).toHaveBeenCalledTimes(1);
    expect(decrementCount).not.toHaveBeenCalled();
  });

  it("treats a concurrent unique constraint violation as idempotent success", async () => {
    deleteFavorite.mockResolvedValue({ count: 0 });
    createFavorite.mockRejectedValue(p2002Error());

    const result = await run();

    expect(result).toEqual({ success: true, isFavorited: true });
    // create 失败后绝不能递增计数器，否则会漂移
    expect(incrementCount).not.toHaveBeenCalled();
    expect(decrementCount).not.toHaveBeenCalled();
  });

  it("rethrows non-unique-constraint errors", async () => {
    deleteFavorite.mockResolvedValue({ count: 0 });
    createFavorite.mockRejectedValue(new Error("db down"));

    await expect(run()).rejects.toThrow("db down");
    expect(incrementCount).not.toHaveBeenCalled();
  });

  it("rethrows delete failures", async () => {
    deleteFavorite.mockRejectedValue(new Error("db down"));

    await expect(run()).rejects.toThrow("db down");
    expect(createFavorite).not.toHaveBeenCalled();
    expect(decrementCount).not.toHaveBeenCalled();
  });

  it("propagates counter failures after a successful create", async () => {
    deleteFavorite.mockResolvedValue({ count: 0 });
    incrementCount.mockRejectedValue(new Error("db down"));

    await expect(run()).rejects.toThrow("db down");
  });
});
