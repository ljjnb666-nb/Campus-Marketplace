import { describe, expect, it } from "vitest";
import { errandFormSchema } from "@/validators/errand";

describe("errand validators", () => {
  it("accepts a valid errand payload", () => {
    const result = errandFormSchema.safeParse({
      title: "帮我取快递",
      description: "东区快递站有两个中号快递，今晚 8 点前送到宿舍楼下。",
      categoryId: "errand-category-id",
      reward: "8",
      pickupLocation: "东区快递站",
      deliveryLocation: "6 号宿舍楼下",
      deadline: "2026-07-17T20:00",
      contactNote: "到了先发消息",
      needsAdvancePay: "false",
      advanceAmount: "",
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid reward input", () => {
    const result = errandFormSchema.safeParse({
      title: "帮我取快递",
      description: "东区快递站有两个中号快递，今晚 8 点前送到宿舍楼下。",
      categoryId: "errand-category-id",
      reward: "-1",
      pickupLocation: "东区快递站",
      deliveryLocation: "6 号宿舍楼下",
      deadline: "2026-07-17T20:00",
      contactNote: "到了先发消息",
      needsAdvancePay: "false",
      advanceAmount: "",
    });

    expect(result.success).toBe(false);
  });

  it("rejects missing category", () => {
    const result = errandFormSchema.safeParse({
      title: "帮我取快递",
      description: "东区快递站有两个中号快递，今晚 8 点前送到宿舍楼下。",
      categoryId: "",
      reward: "8",
      pickupLocation: "东区快递站",
      deliveryLocation: "6 号宿舍楼下",
      deadline: "2026-07-17T20:00",
      contactNote: "到了先发消息",
      needsAdvancePay: "false",
      advanceAmount: "",
    });

    expect(result.success).toBe(false);
  });
});
