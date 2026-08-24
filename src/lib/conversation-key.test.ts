import { describe, expect, it } from "vitest";
import { computeConversationKey } from "@/lib/conversation-key";

describe("computeConversationKey", () => {
  it("builds a key from type, biz id and participants", async () => {
    const key = await computeConversationKey("PRODUCT", "p1", ["user-b", "user-a"]);

    expect(key).toBe("PRODUCT:p1:user-a:user-b");
  });

  it("is order-insensitive to participant order", async () => {
    const [a, b] = await Promise.all([
      computeConversationKey("ERRAND", "e1", ["u1", "u2"]),
      computeConversationKey("ERRAND", "e1", ["u2", "u1"]),
    ]);

    expect(a).toBe(b);
  });

  it("does not mutate the input array", async () => {
    const participants = ["u2", "u1"];

    await computeConversationKey("SERVICE", "s1", participants);

    expect(participants).toEqual(["u2", "u1"]);
  });

  it("distinguishes keys by business type and id", async () => {
    const productKey = await computeConversationKey("PRODUCT", "1", ["u1", "u2"]);
    const rentalKey = await computeConversationKey("RENTAL", "1", ["u1", "u2"]);
    const otherBizKey = await computeConversationKey("PRODUCT", "2", ["u1", "u2"]);

    expect(new Set([productKey, rentalKey, otherBizKey]).size).toBe(3);
  });
});
