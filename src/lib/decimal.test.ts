import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { decimalValue } from "@/lib/decimal";

describe("decimalValue", () => {
  it("converts price strings into Prisma.Decimal instances", () => {
    const value = decimalValue("19.99");

    expect(value).toBeInstanceOf(Prisma.Decimal);
    expect(value.toString()).toBe("19.99");
    expect(value.toNumber()).toBeCloseTo(19.99);
  });

  it("preserves decimal precision that plain numbers would lose", () => {
    expect(decimalValue("0.1").plus(decimalValue("0.2")).toString()).toBe("0.3");
  });

  it("rejects non-numeric input instead of silently coercing it", () => {
    expect(() => decimalValue("not-a-number")).toThrow();
  });
});
