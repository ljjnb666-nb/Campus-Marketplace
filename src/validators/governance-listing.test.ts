import { describe, expect, it } from "vitest";

import {
  decodeListingModerationCursor,
  encodeListingModerationCursor,
  listingModerationRestoreSchema,
  listingModerationTakedownSchema,
} from "@/validators/governance-listing";

describe("Phase 7C governance-listing validators（.strict() 冻结）", () => {
  it("takedown 只接受 {listingId, reasonCode, note?}；注入字段被显式拒绝", () => {
    const ok = listingModerationTakedownSchema.safeParse({
      listingId: "product-1",
      reasonCode: "PROHIBITED_ITEM",
    });
    expect(ok.success).toBe(true);

    // 伪造身份/范围字段（服务端所有）→ strict 拒绝
    const forged = listingModerationTakedownSchema.safeParse({
      listingId: "product-1",
      reasonCode: "OTHER",
      targetType: "SERVICE",
      ownerId: "attacker-1",
      campusId: "campus-x",
      moderatorId: "attacker-1",
    });
    expect(forged.success).toBe(false);
  });

  it("reasonCode 为 strict enum；note trim + ≤500", () => {
    expect(
      listingModerationTakedownSchema.safeParse({
        listingId: "p1",
        reasonCode: "NONEXISTENT",
      }).success,
    ).toBe(false);

    const parsed = listingModerationTakedownSchema.safeParse({
      listingId: "p1",
      reasonCode: "OTHER",
      note: "  x  ",
    });
    expect(parsed.success && parsed.data.note).toBe("x");

    expect(
      listingModerationTakedownSchema.safeParse({
        listingId: "p1",
        reasonCode: "OTHER",
        note: "x".repeat(501),
      }).success,
    ).toBe(false);
  });

  it("restore 只接受 {moderationId, expectedListingUpdatedAt}；注入字段拒绝", () => {
    const ok = listingModerationRestoreSchema.safeParse({
      moderationId: "moderation-1",
      expectedListingUpdatedAt: "2026-09-13T10:00:00.000Z",
    });
    expect(ok.success).toBe(true);

    const forged = listingModerationRestoreSchema.safeParse({
      moderationId: "moderation-1",
      expectedListingUpdatedAt: "2026-09-13T10:00:00.000Z",
      targetType: "PRODUCT",
      listingId: "product-1",
      campusId: "campus-1",
      roleKey: "PLATFORM_ADMIN",
    });
    expect(forged.success).toBe(false);
  });

  it("cursor codec：伪造/损坏 cursor → null（安全失败态）", () => {
    const cursor = { createdAt: new Date("2026-09-13T10:00:00.000Z"), id: "product-1" };
    const encoded = encodeListingModerationCursor(cursor);
    expect(decodeListingModerationCursor(encoded)).toEqual(cursor);
    expect(decodeListingModerationCursor("!!!not-base64url!!!")).toBeNull();
    expect(decodeListingModerationCursor(Buffer.from('{"id":"x"}').toString("base64url"))).toBeNull();
    expect(
      decodeListingModerationCursor(
        Buffer.from(
          JSON.stringify({ createdAt: "not-a-date", id: "x" }),
        ).toString("base64url"),
      ),
    ).toBeNull();
  });
});
