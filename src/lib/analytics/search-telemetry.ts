/**
 * 10K-R2a: explicit, privacy-minimal search submission telemetry.
 *
 * NEVER pass the search keyword, headers, IP, user, campus, or request ID to
 * Prisma, DomainEvent, Audit, logger or Redis. Only a random signed form token
 * digest survives briefly for deduplication. No GET render is counted.
 *
 * Collection is OFF unless explicitly enabled following privacy/deployment review.
 * Bucket statistics are NOT published: coverage failures still make the R1
 * SEARCH_ZERO_RESULT_RATE measurement UNAVAILABLE.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSearchResults } from "@/repositories/search-repository";

const TOKEN_LIFETIME_MS = 20 * 60_000;
const CLAIM_RETENTION_MS = 24 * 60 * 60_000;
const BUCKET_RETENTION_MS = 31 * 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const BOT_PATTERN = /bot|crawl|spider|headless|lighthouse|playwright|slurp|preview|monitor/i;

export type SearchCaptureResult =
  | "DISABLED" | "INELIGIBLE" | "RECORDED" | "DUPLICATE" | "FAILED";

export function searchTelemetryEnabled(): boolean {
  return process.env.SEARCH_TELEMETRY_CAPTURE === "enabled";
}

function signingSecret(): string | null {
  const value = process.env.NEXTAUTH_SECRET;
  return typeof value === "string" && value.length >= 24 ? value : null;
}

export function createSearchTelemetryTicket(now: number = Date.now()): string {
  if (!searchTelemetryEnabled()) return "";
  const secret = signingSecret();
  if (!secret) return "";
  const payload = `${now}.${randomBytes(16).toString("hex")}`;
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

export function validateSearchTelemetryTicket(ticket: string, now: number = Date.now()): string | null {
  const secret = signingSecret();
  if (!secret || typeof ticket !== "string") return null;
  const match = /^(\d{13})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(ticket);
  if (!match) return null;
  const issuedAt = Number(match[1]);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now || now - issuedAt > TOKEN_LIFETIME_MS) {
    return null;
  }
  const expected = createHmac("sha256", secret)
    .update(`${match[1]}.${match[2]}`).digest();
  const supplied = Buffer.from(match[3], "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  return createHash("sha256").update(ticket).digest("hex");
}

/** Conservative bot / navigation exclusion. Not a fraud-proof human identity. */
export function eligibleSubmissionHeaders(headers: Headers): boolean {
  const canonicalOrigin = process.env.NEXTAUTH_URL;
  if (!canonicalOrigin) return false;
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(canonicalOrigin).origin;
  } catch {
    return false;
  }
  const userAgent = headers.get("user-agent") ?? "";
  return headers.get("origin") === expectedOrigin
    && headers.get("sec-fetch-site") === "same-origin"
    && headers.get("sec-fetch-user") === "?1"
    && !BOT_PATTERN.test(userAgent);
}

export function eligibleSearchKeyword(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim().length <= 120
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Called ONLY by explicit form POST. Search query succeeds before any write.
 * Atomic unique claim + hourly increment prevents retry/double-click inflation.
 * Database failure never changes the response delivered by /search.
 */
export async function captureCompletedSearch(input: {
  keyword: string;
  ticket: string;
  headers: Headers;
  now?: Date;
}): Promise<SearchCaptureResult> {
  if (!searchTelemetryEnabled()) return "DISABLED";
  const now = input.now ?? new Date();
  const digest = validateSearchTelemetryTicket(input.ticket, now.getTime());
  if (!eligibleSearchKeyword(input.keyword)
    || !eligibleSubmissionHeaders(input.headers)
    || !digest) return "INELIGIBLE";

  try {
    const results = await getSearchResults(input.keyword.trim());
    const zero = results.products.length === 0 && results.errands.length === 0
      && results.services.length === 0 && results.users.length === 0;
    const hourStart = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
    return await prisma.$transaction(tx => recordCompletedSearchTx(tx as Prisma.TransactionClient, {
      digest, zero, now, hourStart,
    }));
  } catch {
    // Deliberately do NOT log arbitrary errors: DB/driver errors may contain SQL
    // query parameters. Coverage of this hour remains UNKNOWN.
    return "FAILED";
  }
}

/** Exported transaction seam for real-PostgreSQL atomicity and mismatch-db tests. */
export async function recordCompletedSearchTx(
  tx: Prisma.TransactionClient,
  input: { digest: string; zero: boolean; now: Date; hourStart: Date },
): Promise<"RECORDED" | "DUPLICATE"> {
  const { digest, zero, now, hourStart } = input;
  if (!/^[a-f0-9]{64}$/.test(digest)
    || !Number.isFinite(now.getTime())
    || hourStart.getTime() !== Math.floor(now.getTime() / HOUR_MS) * HOUR_MS) {
    throw new Error("SEARCH_TELEMETRY_INTERNAL_FACT_INVALID");
  }
  const claimed = await tx.searchTelemetryClaim.createMany({
    data: [{ digest, expiresAt: new Date(now.getTime() + CLAIM_RETENTION_MS) }],
    skipDuplicates: true,
  });
  if (claimed.count === 0) return "DUPLICATE";
  await tx.searchTelemetryHour.upsert({
    where: { hourStart },
    create: {
      hourStart, attempts: BigInt(1), zeroResults: zero ? BigInt(1) : BigInt(0),
      expiresAt: new Date(hourStart.getTime() + BUCKET_RETENTION_MS),
    },
    update: {
      attempts: { increment: BigInt(1) },
      zeroResults: { increment: zero ? BigInt(1) : BigInt(0) },
    },
  });
  return "RECORDED";
}
