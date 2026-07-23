import { describe, expect, it } from "vitest";
import { productConversationSchema, sendMessageSchema } from "@/validators/conversation";

describe("conversation validators", () => {
  it("accepts a valid product conversation payload", () => {
    const result = productConversationSchema.safeParse({
      productId: "product-id",
    });

    expect(result.success).toBe(true);
  });

  it("rejects empty message content", () => {
    const result = sendMessageSchema.safeParse({
      conversationId: "conversation-id",
      content: "   ",
    });

    expect(result.success).toBe(false);
  });
});
