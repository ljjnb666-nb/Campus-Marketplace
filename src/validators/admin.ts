import { z } from "zod";

export const verificationReviewSchema = z.object({
  verificationId: z.string().trim().min(1),
  userId: z.string().trim().min(1),
  status: z.enum(["VERIFIED", "REJECTED"]),
  reviewNote: z
    .string()
    .trim()
    .max(200, "审核备注不能超过 200 个字")
    .optional()
    .transform((value) => value ?? ""),
});

export const reportReviewSchema = z.object({
  reportId: z.string().trim().min(1),
  status: z.enum(["IN_REVIEW", "RESOLVED", "REJECTED"]),
  handledNote: z
    .string()
    .trim()
    .max(300, "处理备注不能超过 300 个字")
    .optional()
    .transform((value) => value ?? ""),
});
