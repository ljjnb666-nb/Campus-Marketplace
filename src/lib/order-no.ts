import { randomBytes } from "node:crypto";

/**
 * 生成带随机后缀的订单号。
 * 旧实现使用 Date.now() 后 6 位，同毫秒并发下单会命中 orderNo 唯一索引（P2002），
 * 这里改为 4 字节随机十六进制，单日前缀下的碰撞概率可忽略。
 */
export function createOrderNo(prefix = "CM") {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  const suffix = randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}${date}${suffix}`;
}
