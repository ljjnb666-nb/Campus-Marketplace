import { redirect } from "next/navigation";

/**
 * Phase 7F legacy retirement：/admin/verifications 已退役——canonical 认证
 * 审核面是 /governance/verifications（scope truth =
 * UserVerification.membership.campusId ∧ membership ACTIVE；decision 唯一
 * authority = decideMembershipVerification canonical state machine）。
 *
 * redirect 无条件执行（无 requireAdmin 桥）：未授权访问会在目标页被
 * requireVerificationReviewer → notFound 拦截。旧 reviewVerification action
 * 保留为同 seam 的薄 adapter（零第二 mutation authority）。
 */
export default function AdminVerificationsPage() {
  redirect("/governance/verifications");
}
