import { describe, expect, it } from "vitest";
import { orderStatusSchema, productOrderFormSchema, serviceOrderFormSchema } from "@/validators/order";

describe("order validators", () => {
  it("accepts a valid service order payload", () => {
    const result = serviceOrderFormSchema.safeParse({
      serviceId: "service-id",
      meetingLocation: "图书馆一楼大厅",
      note: "希望周六下午沟通需求细节",
    });

    expect(result.success).toBe(true);
  });

  it("accepts a valid product order payload", () => {
    const result = productOrderFormSchema.safeParse({
      productId: "product-id",
      meetingLocation: "南门快递柜旁边",
      note: "今晚 8 点后可以面交",
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid status transition payload", () => {
    const result = orderStatusSchema.safeParse({
      orderId: "order-id",
      status: "PENDING",
    });

    expect(result.success).toBe(false);
  });
});
