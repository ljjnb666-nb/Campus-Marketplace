import { Prisma } from "@prisma/client";

/** 统一的金额/单价字符串转换，避免各 action 重复定义 */
export function decimalValue(value: string) {
  return new Prisma.Decimal(value);
}
