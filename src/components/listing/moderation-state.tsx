/**
 * Phase 7C OWNER 面安全状态标识（R6 冻结）：
 * - 仅呈现"治理处理中"安全文案；
 * - 绝不暴露 moderator 身份、内部 note、审计 metadata、reporter 等
 *   governance-only 信息；
 * - 已注销/删除 owner 的 listing 恢复被 NOT_RESTORABLE 阻断，本标识
 *   不提供任何治理申诉入口（OWNER_EDIT_WHILE_HIDDEN = ALLOWED_V1）。
 */
export function ModerationPendingBadge() {
  return (
    <span
      className="inline-flex items-center rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800"
      data-testid="moderation-pending-badge"
    >
      治理处理中 · 对其他用户隐藏
    </span>
  );
}

/** PUBLIC detail 页 owner 视图横幅（同款安全文案；语义与 badge 一致）。 */
export function ModerationHiddenBanner() {
  return (
    <div
      className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-800"
      data-testid="moderation-hidden-banner"
    >
      治理处理中：该内容当前对其他用户隐藏。你仍可编辑，但在治理结束前不会公开展示。
    </div>
  );
}
