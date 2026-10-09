import "server-only";
import { cookies } from "next/headers";
import { orderAttributionEnabled } from "@/lib/analytics/order-conversation-attribution";

// A browser can only carry one short-lived order origin at a time. Do not
// accept client form fields, URL search params, localStorage or referrer.
export const ORDER_ORIGIN_COOKIE = "czi_order_origin_v1";
const MAX_AGE_SECONDS = 20 * 60;

export async function readOrderOriginCookie(): Promise<string | null> {
  if (!orderAttributionEnabled()) return null;
  const value = (await cookies()).get(ORDER_ORIGIN_COOKIE)?.value;
  return value && value.length <= 1024 ? value : null;
}

export async function setOrderOriginCookie(token: string | null): Promise<void> {
  const jar = await cookies();
  if (!token || !orderAttributionEnabled()) {
    jar.delete(ORDER_ORIGIN_COOKIE);
    return;
  }
  jar.set(ORDER_ORIGIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function clearOrderOriginCookie(): Promise<void> {
  if (!orderAttributionEnabled()) return;
  (await cookies()).delete(ORDER_ORIGIN_COOKIE);
}
