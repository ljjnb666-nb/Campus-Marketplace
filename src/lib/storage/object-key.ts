import { randomUUID } from "node:crypto";

/**
 * Object key 生成：路径各段全部由服务器控制，
 * 用户输入（文件名等）绝不参与 key 拼接。
 *
 * 布局：
 *   public/avatars/{userId}/{uuid}.webp
 *   public/products/{userId}/{uuid}.webp
 *   private/verification/{userId}/{uuid}.webp
 *   ...
 */

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const EXTENSION_PATTERN = /^\.(webp|png|jpg)$/;

export const KEY_ROOT_BY_ACCESS = {
  PUBLIC: "public",
  PRIVATE: "private",
} as const;

export type ObjectKeyAccess = keyof typeof KEY_ROOT_BY_ACCESS;

export interface BuildObjectKeyInput {
  access: ObjectKeyAccess;
  /** key 中的业务目录段（如 products / verification），只允许固定白名单值 */
  categoryDirectory: string;
  userId: string;
  fileExtension: string;
  /** 可注入随机 ID 用于测试；生产默认 crypto.randomUUID */
  randomId?: string;
}

/**
 * 断言 object key 不含任何路径穿越形态。
 * key 只能是纯 ASCII 相对路径，禁止反斜杠、`..` 段、空段与控制字符。
 */
export function assertSafeObjectKey(objectKey: string): void {
  if (objectKey.length === 0 || objectKey.length > 512) {
    throw new Error("非法的 object key：长度越界");
  }
  if (!/^[\x21-\x7e]+$/.test(objectKey)) {
    throw new Error("非法的 object key：包含不可见字符");
  }
  if (objectKey.includes("\\")) {
    throw new Error("非法的 object key：包含反斜杠");
  }
  if (objectKey.startsWith("/") || objectKey.endsWith("/")) {
    throw new Error("非法的 object key：首尾不能是路径分隔符");
  }
  const segments = objectKey.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("非法的 object key：包含空段或相对路径段");
  }
}

export function buildObjectKey(input: BuildObjectKeyInput): string {
  const { access, categoryDirectory, userId, fileExtension } = input;

  if (!KEY_ROOT_BY_ACCESS[access]) {
    throw new Error("非法的 object key：未知访问级别");
  }
  if (!KEY_SEGMENT_PATTERN.test(categoryDirectory)) {
    throw new Error("非法的 object key：业务目录不合法");
  }
  if (!USER_ID_PATTERN.test(userId)) {
    throw new Error("非法的 object key：用户 ID 不合法");
  }
  if (!EXTENSION_PATTERN.test(fileExtension)) {
    throw new Error("非法的 object key：扩展名不在白名单");
  }

  const randomId = input.randomId ?? randomUUID();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(randomId)) {
    throw new Error("非法的 object key：随机 ID 不合法");
  }

  const objectKey = [
    KEY_ROOT_BY_ACCESS[access],
    categoryDirectory,
    userId,
    `${randomId}${fileExtension}`,
  ].join("/");

  assertSafeObjectKey(objectKey);
  return objectKey;
}

/**
 * 校验 DB 中的 objectKey（读取路径纵深防御），
 * 防止历史脏数据携带穿越形态的 key 直达 SDK。
 */
export function isWellFormedObjectKey(objectKey: string): boolean {
  try {
    assertSafeObjectKey(objectKey);
    return true;
  } catch {
    return false;
  }
}
