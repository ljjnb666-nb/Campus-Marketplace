import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/upload", () => ({
  isStoredImagePath: (value: string) => value.startsWith("/uploads/"),
}));

import {
  rentalCancelSchema,
  rentalDamageClaimRespondSchema,
  rentalDamageClaimSchema,
  rentalDisputeSchema,
  rentalExtensionRequestIdSchema,
  rentalExtensionSchema,
  rentalListingFormSchema,
  rentalOrderCreateSchema,
  rentalOrderIdSchema,
  rentalPickupConfirmSchema,
  rentalRejectSchema,
  rentalReturnConfirmSchema,
  rentalReviewSchema,
} from "@/validators/rental";

function validListingInput() {
  return {
    title: "佳能相机出租",
    description: "95新佳能相机，适合拍毕业照，含电池和充电器。",
    categoryId: "cat-1",
    condition: "LIKE_NEW",
    brand: "Canon",
    model: "M50",
    referenceValue: "3000",
    price: "50",
    pricingUnit: "PER_DAY",
    depositAmount: "200",
    minimumDuration: "1",
    maximumDuration: "7",
    totalQuantity: "1",
    pickupLocation: "东门快递点",
    returnLocation: "东门快递点",
    usageRules: "请小心使用",
    damagePolicy: "损坏照价赔偿",
    overduePolicy: "逾期加收费用",
    requiresApproval: "false",
    imageUrls: ["https://example.com/a.jpg"],
  };
}

describe("rentalListingFormSchema", () => {
  it("accepts a complete valid listing", () => {
    const parsed = rentalListingFormSchema.safeParse(validListingInput());
    expect(parsed.success).toBe(true);
  });

  it("rejects a title that is too short", () => {
    const input = validListingInput();
    input.title = "短";
    const parsed = rentalListingFormSchema.safeParse(input);
    expect(parsed.success).toBe(false);
  });

  it("rejects an invalid condition enum", () => {
    const input = validListingInput();
    input.condition = "BROKEN";
    const parsed = rentalListingFormSchema.safeParse(input);
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-numeric price", () => {
    const input = validListingInput();
    input.price = "abc";
    const parsed = rentalListingFormSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toBe("租金格式不正确");
    }
  });

  it("rejects a negative deposit", () => {
    const input = validListingInput();
    input.depositAmount = "-1";
    const parsed = rentalListingFormSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toBe("押金格式不正确");
    }
  });

  it("allows empty reference value (treated as no estimate)", () => {
    const input = validListingInput();
    input.referenceValue = "";
    const parsed = rentalListingFormSchema.safeParse(input);
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-integer minimum duration", () => {
    const input = validListingInput();
    input.minimumDuration = "1.5";
    const parsed = rentalListingFormSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toBe("最短租期至少为1");
    }
  });

  it("rejects zero quantity", () => {
    const input = validListingInput();
    input.totalQuantity = "0";
    const parsed = rentalListingFormSchema.safeParse(input);
    expect(parsed.success).toBe(false);
  });

  it("defaults totalQuantity to 1 when missing", () => {
    const input = validListingInput();
    delete (input as Record<string, unknown>).totalQuantity;
    const parsed = rentalListingFormSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.totalQuantity).toBe("1");
    }
  });

  it("coerces requiresApproval flag variants to boolean", () => {
    for (const [raw, expected] of [
      ["true", true],
      ["on", true],
      ["1", true],
      [undefined, false],
    ] as const) {
      const input = validListingInput();
      if (raw === undefined) {
        delete (input as Record<string, unknown>).requiresApproval;
      } else {
        input.requiresApproval = raw;
      }
      const parsed = rentalListingFormSchema.safeParse(input);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.requiresApproval).toBe(expected);
      }
    }
  });

  it("accepts stored /uploads/ image paths", () => {
    const input = validListingInput();
    input.imageUrls = ["/uploads/rental/abc.webp"];
    const parsed = rentalListingFormSchema.safeParse(input);
    expect(parsed.success).toBe(true);
  });

  it("rejects malformed image urls", () => {
    const input = validListingInput();
    input.imageUrls = ["ftp://bad.example.com/x.jpg"];
    const parsed = rentalListingFormSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toBe("图片地址格式不正确");
    }
  });

  it("rejects more than 9 images", () => {
    const input = validListingInput();
    input.imageUrls = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}.jpg`);
    const parsed = rentalListingFormSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toContain("最多上传");
    }
  });
});

describe("rentalOrderCreateSchema", () => {
  it("accepts a valid order creation payload", () => {
    const parsed = rentalOrderCreateSchema.safeParse({
      rentalListingId: "listing-1",
      startTime: "2026-09-01T10:00",
      endTime: "2026-09-03T10:00",
      quantity: "2",
      renterNote: "尽快回复",
    });
    expect(parsed.success).toBe(true);
  });

  it("defaults quantity to 1", () => {
    const parsed = rentalOrderCreateSchema.safeParse({
      rentalListingId: "listing-1",
      startTime: "2026-09-01T10:00",
      endTime: "2026-09-03T10:00",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.quantity).toBe("1");
    }
  });

  it("requires start and end times", () => {
    const parsed = rentalOrderCreateSchema.safeParse({ rentalListingId: "listing-1" });
    expect(parsed.success).toBe(false);
  });
});

describe("rental status-related schemas", () => {
  it("rentalExtensionSchema requires a new end time", () => {
    expect(rentalExtensionSchema.safeParse({ orderId: "o1", newEndTime: "" }).success).toBe(false);
    expect(
      rentalExtensionSchema.safeParse({ orderId: "o1", newEndTime: "2026-09-05T10:00" }).success,
    ).toBe(true);
  });

  it("rentalOrderIdSchema rejects empty order id", () => {
    const parsed = rentalOrderIdSchema.safeParse({ orderId: "  " });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toBe("订单不存在");
    }
  });

  it("rentalRejectSchema limits reject reason length", () => {
    const parsed = rentalRejectSchema.safeParse({
      orderId: "o1",
      rejectReason: "a".repeat(201),
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toBe("拒绝原因不能超过200字");
    }
  });

  it("rentalPickupConfirmSchema only accepts owner/renter roles", () => {
    const base = { orderId: "o1", currentCondition: "完好" };
    expect(rentalPickupConfirmSchema.safeParse({ ...base, role: "owner" }).success).toBe(true);
    expect(rentalPickupConfirmSchema.safeParse({ ...base, role: "renter" }).success).toBe(true);
    expect(rentalPickupConfirmSchema.safeParse({ ...base, role: "admin" }).success).toBe(false);
  });

  it("rentalReturnConfirmSchema accepts an inspection note", () => {
    const parsed = rentalReturnConfirmSchema.safeParse({
      orderId: "o1",
      role: "owner",
      inspectionNote: "轻微划痕",
    });
    expect(parsed.success).toBe(true);
  });

  it("rentalCancelSchema validates cancellation reason enum", () => {
    const base = { orderId: "o1" };
    expect(
      rentalCancelSchema.safeParse({ ...base, cancellationReason: "RENTER_CHANGED_PLAN" }).success,
    ).toBe(true);
    expect(
      rentalCancelSchema.safeParse({ ...base, cancellationReason: "NO_REASON" }).success,
    ).toBe(false);
  });

  it("rentalExtensionRequestIdSchema rejects empty id", () => {
    const parsed = rentalExtensionRequestIdSchema.safeParse({ extensionRequestId: "" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toBe("无效请求");
    }
  });

  it("rentalDamageClaimRespondSchema coerces agreed flag to boolean", () => {
    const parsed = rentalDamageClaimRespondSchema.safeParse({
      claimId: "c1",
      agreed: "true",
      renterNote: "同意",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.agreed).toBe(true);
    }
    expect(
      rentalDamageClaimRespondSchema.safeParse({ claimId: "c1", agreed: "yes" }).success,
    ).toBe(false);
  });

  it("rentalDisputeSchema enforces minimum reason length", () => {
    const parsed = rentalDisputeSchema.safeParse({ orderId: "o1", reason: "太短" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toContain("至少5个字");
    }
  });

  it("rentalDamageClaimSchema requires numeric deduction", () => {
    expect(
      rentalDamageClaimSchema.safeParse({
        orderId: "o1",
        damageDescription: "屏幕碎裂需要维修",
        requestedDeduction: "100",
      }).success,
    ).toBe(true);
    expect(
      rentalDamageClaimSchema.safeParse({
        orderId: "o1",
        damageDescription: "屏幕碎裂需要维修",
        requestedDeduction: "abc",
      }).success,
    ).toBe(false);
  });
});

describe("rentalReviewSchema", () => {
  it("coerces string ratings to numbers within range", () => {
    const parsed = rentalReviewSchema.safeParse({
      orderId: "o1",
      overallRating: "5",
      content: "很好",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.overallRating).toBe(5);
    }
  });

  it("rejects out-of-range ratings", () => {
    expect(
      rentalReviewSchema.safeParse({ orderId: "o1", overallRating: 6 }).success,
    ).toBe(false);
    expect(
      rentalReviewSchema.safeParse({ orderId: "o1", overallRating: 0 }).success,
    ).toBe(false);
  });

  it("defaults tags to empty array", () => {
    const parsed = rentalReviewSchema.safeParse({ orderId: "o1", overallRating: 4 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tags).toEqual([]);
    }
  });
});
