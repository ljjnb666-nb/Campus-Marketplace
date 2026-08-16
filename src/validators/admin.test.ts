import { describe, expect, it } from "vitest";
import {
  categoryFormSchema,
  categoryStatusSchema,
  moderateListingSchema,
  moderationKeywordSchema,
  moderationKeywordStatusSchema,
  reportReviewSchema,
  toggleUserStatusSchema,
  verificationReviewSchema,
} from "@/validators/admin";

describe("admin validators", () => {
  it("accepts a valid verification review payload", () => {
    const result = verificationReviewSchema.safeParse({
      verificationId: "verification-id",
      userId: "user-id",
      status: "VERIFIED",
      reviewNote: "信息核对通过",
    });

    expect(result.success).toBe(true);
  });

  it("fills an empty verification review note with a default string", () => {
    const result = verificationReviewSchema.parse({
      verificationId: "verification-id",
      userId: "user-id",
      status: "REJECTED",
      reviewNote: undefined,
    });

    expect(result.reviewNote).toBe("");
  });

  it("rejects a verification review note that is too long", () => {
    const result = verificationReviewSchema.safeParse({
      verificationId: "verification-id",
      userId: "user-id",
      status: "REJECTED",
      reviewNote: "a".repeat(201),
    });

    expect(result.success).toBe(false);
  });

  it("accepts valid report review statuses", () => {
    const inReview = reportReviewSchema.safeParse({
      reportId: "report-id",
      status: "IN_REVIEW",
      handledNote: "已开始核查",
    });

    const resolved = reportReviewSchema.safeParse({
      reportId: "report-id",
      status: "RESOLVED",
      handledNote: "违规内容已下架",
    });

    const rejected = reportReviewSchema.safeParse({
      reportId: "report-id",
      status: "REJECTED",
      handledNote: "证据不足",
    });

    expect(inReview.success).toBe(true);
    expect(resolved.success).toBe(true);
    expect(rejected.success).toBe(true);
  });

  it("fills an empty report handled note with a default string", () => {
    const result = reportReviewSchema.parse({
      reportId: "report-id",
      status: "IN_REVIEW",
      handledNote: undefined,
    });

    expect(result.handledNote).toBe("");
  });

  it("rejects invalid report review payload", () => {
    const result = reportReviewSchema.safeParse({
      reportId: "report-id",
      status: "PENDING",
      handledNote: "test",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a report handled note that is too long", () => {
    const result = reportReviewSchema.safeParse({
      reportId: "report-id",
      status: "RESOLVED",
      handledNote: "a".repeat(301),
    });

    expect(result.success).toBe(false);
  });

  it("accepts a valid user status toggle payload", () => {
    const result = toggleUserStatusSchema.safeParse({
      userId: "user-1",
      nextStatus: "SUSPENDED",
    });

    expect(result.success).toBe(true);
  });

  it("rejects an invalid user status toggle payload", () => {
    const result = toggleUserStatusSchema.safeParse({
      userId: "user-1",
      nextStatus: "DELETED",
    });

    expect(result.success).toBe(false);
  });

  it("accepts a valid listing moderation payload", () => {
    const result = moderateListingSchema.safeParse({
      targetType: "PRODUCT",
      targetId: "product-1",
    });

    expect(result.success).toBe(true);
  });

  it("rejects a moderation payload with a blank target id", () => {
    const result = moderateListingSchema.safeParse({
      targetType: "PRODUCT",
      targetId: "   ",
    });

    expect(result.success).toBe(false);
  });

  it("coerces and transforms a valid category form payload", () => {
    const result = categoryFormSchema.parse({
      name: "代取快递",
      slug: "pickup",
      description: "快递代取类任务",
      sortOrder: "2",
      isActive: "false",
    });

    expect(result).toEqual({
      categoryId: undefined,
      name: "代取快递",
      slug: "pickup",
      description: "快递代取类任务",
      sortOrder: 2,
      isActive: false,
    });
  });

  it("rejects a category form with an empty name", () => {
    const result = categoryFormSchema.safeParse({
      name: "  ",
      slug: "pickup",
      sortOrder: "2",
      isActive: "true",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a category form with an out-of-range sort order", () => {
    const result = categoryFormSchema.safeParse({
      name: "代取快递",
      slug: "pickup",
      sortOrder: "1000",
      isActive: "true",
    });

    expect(result.success).toBe(false);
  });

  it("transforms the category status payload into booleans", () => {
    const result = categoryStatusSchema.parse({
      categoryId: "category-1",
      isActive: "false",
    });

    expect(result).toEqual({ categoryId: "category-1", isActive: false });
  });

  it("rejects a category status payload without an id", () => {
    const result = categoryStatusSchema.safeParse({
      categoryId: "",
      isActive: "false",
    });

    expect(result.success).toBe(false);
  });

  it("accepts and transforms a valid moderation keyword payload", () => {
    const result = moderationKeywordSchema.parse({
      keyword: "代考",
      targetType: "GLOBAL",
      isEnabled: "false",
    });

    expect(result).toEqual({
      keywordId: undefined,
      keyword: "代考",
      targetType: "GLOBAL",
      isEnabled: false,
    });
  });

  it("rejects a moderation keyword that is too long", () => {
    const result = moderationKeywordSchema.safeParse({
      keyword: "a".repeat(41),
      targetType: "GLOBAL",
      isEnabled: "true",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a keyword status payload without an id", () => {
    const result = moderationKeywordStatusSchema.safeParse({
      keywordId: "",
      isEnabled: "true",
    });

    expect(result.success).toBe(false);
  });
});
