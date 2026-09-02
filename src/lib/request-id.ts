/**
 * Request / Correlation ID 纯函数（TASK 1）。
 *
 * 本模块必须保持 runtime 无关（Edge middleware 与 Node server 共用）：
 * 只做格式校验与生成，不依赖 node:async_hooks。
 *
 * 安全约束：
 * - 客户端提供的 X-Request-ID 不盲信：必须命中严格白名单格式
 *   （字母/数字/._-，8-64 位，字母或数字开头），否则重新生成；
 * - 生成的 ID 只包含十六进制字符，天然不可能携带
 *   email / userId / IP / cookie / token / session 等用户数据；
 * - 格式校验同时阻断 header 注入（CR/LF/控制字符无法通过白名单）。
 */

export const REQUEST_ID_HEADER = "x-request-id";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{7,63}$/;

export function isValidRequestId(value: string | null | undefined): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

/** 生成 32 位十六进制安全随机 request ID（crypto.randomUUID 去连字符）。 */
export function generateRequestId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * 解析请求 ID：客户端提供的合法 ID 透传（跨服务链路追踪），
 * 非法/缺失则生成新 ID。永不去信任原始输入。
 */
export function resolveRequestId(incoming: string | null | undefined): string {
  return isValidRequestId(incoming) ? incoming : generateRequestId();
}
