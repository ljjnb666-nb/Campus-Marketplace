import { describe, expect, it } from "vitest";
import { computeConversationKey } from "@/lib/conversation-key";

describe("Conversation concurrency and key calculation", () => {
  it("computes identical deterministic conversationKey regardless of participant order", async () => {
    const key1 = await computeConversationKey("PRODUCT", "prod_100", ["user_A", "user_B"]);
    const key2 = await computeConversationKey("PRODUCT", "prod_100", ["user_B", "user_A"]);

    expect(key1).toBe("PRODUCT:prod_100:user_A:user_B");
    expect(key2).toBe("PRODUCT:prod_100:user_A:user_B");
    expect(key1).toBe(key2);
  });

  it("differentiates conversationKeys for different business domains", async () => {
    const productKey = await computeConversationKey("PRODUCT", "100", ["user_A", "user_B"]);
    const rentalKey = await computeConversationKey("RENTAL", "100", ["user_A", "user_B"]);
    const orderKey = await computeConversationKey("PRODUCT_ORDER", "100", ["user_A", "user_B"]);

    expect(productKey).not.toBe(rentalKey);
    expect(rentalKey).not.toBe(orderKey);
  });
});
