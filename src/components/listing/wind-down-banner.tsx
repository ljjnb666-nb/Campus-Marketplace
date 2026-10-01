import { Info } from "lucide-react";

/**
 * Phase 8F（§45）：owner / 既有交易参与方查看 wind-down listing 时的
 * 明确中文状态提示。公开曝光状态（PUBLIC）不渲染本横幅；新市场活动
 * 按钮（购买/预约/租用/接单/收藏/私聊）由各 detail console 按 lifecycle
 * policy 收敛，服务端 authority 仍是唯一权威（§46）。
 */
export function WindDownBanner({ message }: { message: string }) {
  if (!message) {
    return null;
  }

  return (
    <div
      role="status"
      className="mt-4 flex items-start gap-3 rounded-2xl border border-amber-200/70 bg-amber-50/70 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200"
    >
      <Info className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
