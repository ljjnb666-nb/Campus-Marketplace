import { describe, expect, it } from "vitest";
import { reportFormSchema, reviewFormSchema } from "@/validators/trust";

describe("trust validators", () => {
  it("accepts a valid review payload", () => {
    const result = reviewFormSchema.safeParse({
      orderId: "order-id",
      targetUserId: "user-id",
      rating: "5",
      content: "沟通顺畅，交易很快完成。",
      tags: "回复及时,守时",
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid report payload", () => {
    const result = reportFormSchema.safeParse({
      targetType: "PRODUCT",
      reason: "INVALID",
      detail: "test",
      productId: "product-id",
    });

    expect(result.success).toBe(false);
  });
});
