/**
 * 操作模式契约（Phase 4 修复轮 3）：两个运维 CLI（ops-check /
 * backup-health-check）共享的严格 mode 解析。
 *
 * fail-closed 语义：
 * - 未显式提供 --mode（undefined）→ 默认：NODE_ENV=production → "production"，
 *   否则 "development"（"参数未提供" 与 "参数非法" 必须区分）；
 * - 显式提供的值必须严格属于允许集合（production/development/ci），
 *   任何未知/拼写错误/空值 → { ok: false }——不得猜测最近似值、
 *   不得降级为 development、不得 fallback 到 NODE_ENV。
 *
 * 只做字符串集合校验：无新依赖、无 command framework。
 */

export const OPERATION_MODES = ["production", "development", "ci"] as const;

export type OperationMode = (typeof OPERATION_MODES)[number];

export type ParsedOperationMode =
  | { ok: true; mode: OperationMode }
  | { ok: false };

export function parseOperationMode(raw: string | undefined): ParsedOperationMode {
  // 未提供（undefined）：允许按 NODE_ENV 取默认
  if (raw === undefined) {
    return { ok: true, mode: process.env.NODE_ENV === "production" ? "production" : "development" };
  }
  // 显式提供：严格白名单，未知值一律拒绝（含空字符串）
  if ((OPERATION_MODES as readonly string[]).includes(raw)) {
    return { ok: true, mode: raw as OperationMode };
  }
  return { ok: false };
}

/**
 * 从 argv 提取显式 --mode 的原始值。
 * - argv 无 --mode → undefined（未提供）；
 * - --mode 位于末尾（缺值）或下一个 token 是另一个 flag → ""（非法值，
 *   由 parseOperationMode 拒绝）；
 * - 否则返回紧随其后的 token 原样。
 */
export function extractModeArg(argv: string[]): string | undefined {
  const index = argv.indexOf("--mode");
  if (index === -1) {
    return undefined;
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("--")) {
    return "";
  }
  return next;
}
