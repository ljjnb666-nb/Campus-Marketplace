import { NextResponse, type NextRequest } from "next/server";
import {
  captureCompletedSearch,
  eligibleSearchKeyword,
  searchTelemetryEnabled,
} from "@/lib/analytics/search-telemetry";

export const runtime = "nodejs";

/** Explicit browser form submission only; GET and background navigation are not facts. */
export async function POST(request: NextRequest) {
  const fallback = new URL("/search", request.url);
  const contentType = request.headers.get("content-type") ?? "";
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!contentType.startsWith("application/x-www-form-urlencoded")
    || !Number.isFinite(length) || length > 4096) {
    return NextResponse.redirect(fallback, { status: 303 });
  }

  let q: string | null = null;
  let ticket: string | null = null;
  // Content-Length is untrusted or absent behind proxies. Bound actual bytes
  // before parsing: a malicious POST must not force unbounded formData buffering.
  const reader = request.body?.getReader();
  if (!reader) return NextResponse.redirect(fallback, { status: 303 });
  const chunks: Uint8Array[] = [];
  let readBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      readBytes += chunk.value.byteLength;
      if (readBytes > 4096) {
        await reader.cancel();
        return NextResponse.redirect(fallback, { status: 303 });
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(readBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const fields = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (fields.getAll("q").length === 1) q = fields.get("q");
    if (fields.getAll("ticket").length === 1) ticket = fields.get("ticket");
  } catch {
    return NextResponse.redirect(fallback, { status: 303 });
  } finally {
    reader.releaseLock();
  }

  if (typeof q !== "string" || !q.trim()) {
    return NextResponse.redirect(fallback, { status: 303 });
  }
  const keyword = q.trim();
  fallback.searchParams.set("q", keyword);

  // Search results are always rendered via the unchanged canonical GET read.
  // An analytics failure MUST NOT prevent the Post/Redirect/Get navigation.
  if (searchTelemetryEnabled()
    && eligibleSearchKeyword(keyword)
    && typeof ticket === "string") {
    await captureCompletedSearch({ keyword, ticket, headers: request.headers });
  }
  return NextResponse.redirect(fallback, { status: 303 });
}
