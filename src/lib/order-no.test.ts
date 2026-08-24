import { describe, expect, it } from "vitest";
import { createOrderNo } from "@/lib/order-no";

describe("createOrderNo", () => {
  it("generates today's date prefix with the default CM marker", () => {
    const orderNo = createOrderNo();

    const now = new Date();
    const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
      now.getDate(),
    ).padStart(2, "0")}`;
    expect(orderNo).toMatch(new RegExp(`^CM${date}[0-9A-F]{8}$`));
  });

  it("supports custom prefixes", () => {
    expect(createOrderNo("RT")).toMatch(/^RT\d{8}[0-9A-F]{8}$/);
  });

  it("generates unique suffixes for same-millisecond calls", () => {
    const numbers = new Set(Array.from({ length: 50 }, () => createOrderNo()));

    expect(numbers.size).toBe(50);
  });
});
