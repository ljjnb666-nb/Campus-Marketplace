/**
 * Phase 9B（§40）：reusable HTML escape helper——所有 email 模板 dynamic
 * value 必须经此转义；< > & " ' 五个危险字符全部转义，杜绝 HTML injection。
 *
 * 独立 leaf 模块：notification-registry（纯契约层，§7 禁止 import DB/
 * service 层）可直接 import 本文件实现 renderEmail，避免 renderer ↔
 * registry 循环依赖。
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}
