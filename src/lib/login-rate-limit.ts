import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isRateLimited, resetRateLimit } from "@/lib/rate-limit";

export const LOGIN_SOURCE_LIMIT = 60;
export const LOGIN_ACCOUNT_SOURCE_LIMIT = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** Production Caddy overwrites X-Real-IP. The application must remain behind
 * that trusted proxy; invalid/missing addresses share a fail-closed bucket. */
export function resolveAuthClientSource(headers: Record<string, unknown> | undefined): string {
  const raw = headers?.["x-real-ip"] ?? headers?.["x-forwarded-for"];
  const first = (Array.isArray(raw) ? raw[0] : raw);
  const candidate = typeof first === "string" ? first.split(",")[0].trim() : "";
  return isIP(candidate) ? candidate.toLowerCase() : "unknown";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function loginRateLimitKeys(email: string | undefined, headers?: Record<string, unknown>) {
  const source = resolveAuthClientSource(headers);
  return {
    sourceKey: `login:source:${digest(source)}`,
    accountSourceKey: `login:account-source:${digest(JSON.stringify([source, email?.trim().toLowerCase() ?? ""]))}`,
  };
}

/** Do not globally lock an account on untrusted failures. Account throttling
 * is scoped to its source; the independent source budget prevents email
 * rotation/password spraying. Successful auth only resets the pair, never
 * the source budget (otherwise an attacker's own account launders attempts). */
export async function consumeCredentialLoginBudget(
  email: string | undefined, headers?: Record<string, unknown>,
): Promise<{ limited: boolean; accountSourceKey: string }> {
  const keys = loginRateLimitKeys(email, headers);
  const source = await isRateLimited({ key: keys.sourceKey, limit: LOGIN_SOURCE_LIMIT, windowMs: LOGIN_WINDOW_MS });
  if (source.limited) return { limited: true, accountSourceKey: keys.accountSourceKey };
  const account = await isRateLimited({ key: keys.accountSourceKey, limit: LOGIN_ACCOUNT_SOURCE_LIMIT, windowMs: LOGIN_WINDOW_MS });
  return { limited: account.limited, accountSourceKey: keys.accountSourceKey };
}

export async function finishCredentialLoginBudget(accountSourceKey: string): Promise<void> {
  await resetRateLimit(accountSourceKey);
}
