import { beforeEach, describe, expect, it, vi } from "vitest";

const { enabled, cookieStore, cookiesMock } = vi.hoisted(() => {
  const cookieStore = {
    get: vi.fn(), set: vi.fn(), delete: vi.fn(),
  };
  return {
    enabled: vi.fn(),
    cookieStore,
    cookiesMock: vi.fn(async () => cookieStore),
  };
});
vi.mock("next/headers", () => ({ cookies: cookiesMock }));
vi.mock("@/lib/analytics/order-conversation-attribution", () => ({
  orderAttributionEnabled: enabled,
}));

import {
  ORDER_ORIGIN_COOKIE, readOrderOriginCookie,
  setOrderOriginCookie, clearOrderOriginCookie,
} from "@/lib/analytics/order-origin-cookie";

beforeEach(() => {
  vi.resetAllMocks();
  enabled.mockReturnValue(true);
  cookiesMock.mockResolvedValue(cookieStore);
});

describe("10K-R2c-02B analytics cookie failure isolation", () => {
  it("never blocks order creation when reading its optional origin fails", async () => {
    cookiesMock.mockRejectedValueOnce(new Error("COOKIE_UNAVAILABLE"));
    await expect(readOrderOriginCookie()).resolves.toBeNull();
  });

  it("a valid origin is still read, and excessive bytes are excluded", async () => {
    cookieStore.get.mockReturnValueOnce({ value: "signed-origin" });
    expect(await readOrderOriginCookie()).toBe("signed-origin");
    cookieStore.get.mockReturnValueOnce({ value: "x".repeat(1025) });
    expect(await readOrderOriginCookie()).toBeNull();
  });

  it("cannot turn committed-order success into a failed action due to deletion error", async () => {
    cookieStore.delete.mockImplementationOnce(() => { throw new Error("COOKIE_DELETE_DENIED"); });
    await expect(clearOrderOriginCookie()).resolves.toBeUndefined();
    expect(cookieStore.delete).toHaveBeenCalledWith(ORDER_ORIGIN_COOKIE);
  });

  it("cannot break navigation because optional cookie state is unavailable", async () => {
    cookiesMock.mockRejectedValueOnce(new Error("COOKIE_STORE_UNAVAILABLE"));
    await expect(setOrderOriginCookie("signed-origin")).resolves.toBeUndefined();
    cookieStore.set.mockImplementationOnce(() => { throw new Error("COOKIE_SET_DENIED"); });
    await expect(setOrderOriginCookie("signed-origin")).resolves.toBeUndefined();
    cookieStore.delete.mockImplementationOnce(() => { throw new Error("COOKIE_DELETE_DENIED"); });
    await expect(setOrderOriginCookie(null)).resolves.toBeUndefined();
  });

  it("still enforces short-lived, HttpOnly, strict cookie semantics", async () => {
    await setOrderOriginCookie("signed-origin");
    expect(cookieStore.set).toHaveBeenCalledWith(ORDER_ORIGIN_COOKIE, "signed-origin",
      expect.objectContaining({ httpOnly: true, sameSite: "strict", maxAge: 1200, path: "/" }));
    await clearOrderOriginCookie();
    expect(cookieStore.delete).toHaveBeenCalledWith(ORDER_ORIGIN_COOKIE);
  });

  it("disabled attribution never reads nor deletes cookies on order commit", async () => {
    enabled.mockReturnValue(false);
    await expect(readOrderOriginCookie()).resolves.toBeNull();
    await clearOrderOriginCookie();
    expect(cookiesMock).not.toHaveBeenCalled();
  });
});
