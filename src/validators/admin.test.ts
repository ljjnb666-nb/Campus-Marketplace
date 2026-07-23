import { describe, expect, it } from "vitest";
import { reportReviewSchema, verificationReviewSchema } from "@/validators/admin";

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
});
