/**
 * Issue #115 R16. Per-call login network evidence, never authentication state.
 * Only requests *started after* the current helper's click window is armed
 * can contribute positive callback evidence. A response/failure must belong
 * to the exact Request object we observed, not just have a matching URL.
 * All counters and request references are bounded; no request payloads,
 * credentials, tokens, full URLs or error text are retained or logged.
 */
type ObservedRequest = { url(): string };
type ObservedResponse = { request(): ObservedRequest; status(): number };
type CallbackStatus = "none" | "2xx" | "3xx" | "4xx" | "5xx" | "mixed";
type CallbackPhase =
  | "not_observed"
  | "request_pending"
  | "response_observed"
  | "request_failed"
  | "mixed_outcomes"
  | "tracking_saturated";

const MAX_TRACKED_REQUESTS = 9;

export function createLoginAttemptNetworkEvidence(loginOrigin: string) {
  let armed = false;
  let preAttemptSeen = false;
  let orphanResponseSeen = false;
  let trackingSaturated = false;
  let callbackStatus: CallbackStatus = "none";
  const requests = new Set<ObservedRequest>();
  const responses = new Set<ObservedRequest>();
  const failures = new Set<ObservedRequest>();

  const isCredentialsCallback = (request: ObservedRequest): boolean => {
    try {
      const target = new URL(request.url());
      return target.origin === loginOrigin &&
        target.pathname === "/api/auth/callback/credentials";
    } catch {
      return false;
    }
  };
  return {
    begin(): void { armed = true; },
    isArmed(): boolean { return armed; },
    onRequest(request: ObservedRequest): void {
      if (!isCredentialsCallback(request)) return;
      if (!armed) {
        preAttemptSeen = true;
        return;
      }
      if (requests.has(request)) return;
      if (requests.size >= MAX_TRACKED_REQUESTS) {
        trackingSaturated = true;
        return;
      }
      requests.add(request);
    },
    onResponse(response: ObservedResponse): void {
      const request = response.request();
      if (!isCredentialsCallback(request)) return;
      if (!armed || !requests.has(request)) {
        orphanResponseSeen = true;
        return;
      }
      if (responses.has(request)) return;
      responses.add(request);
      const status = response.status();
      const category: CallbackStatus = status >= 200 && status < 300 ? "2xx"
        : status >= 300 && status < 400 ? "3xx"
        : status >= 400 && status < 500 ? "4xx" : "5xx";
      // Multiple callbacks may return different classes. Never imply that the
      // last observed status alone describes the whole login attempt.
      callbackStatus = callbackStatus === "none" ? category
        : callbackStatus === category ? callbackStatus : "mixed";
    },
    onRequestFailed(request: ObservedRequest): void {
      if (!isCredentialsCallback(request) || !armed || !requests.has(request)) return;
      failures.add(request);
    },
    snapshot(): {
      started: boolean;
      status: CallbackStatus;
      transportFailed: boolean;
      phase: CallbackPhase;
      preAttemptSeen: boolean;
      orphanResponseSeen: boolean;
      trackingSaturated: boolean;
    } {
      const pending = [...requests].some((request) =>
        !responses.has(request) && !failures.has(request));
      const phase: CallbackPhase = trackingSaturated ? "tracking_saturated"
        : requests.size === 0 ? "not_observed"
        : pending ? "request_pending"
        : responses.size > 0 && failures.size > 0 ? "mixed_outcomes"
        : failures.size > 0 ? "request_failed"
        : "response_observed";
      return {
        started: requests.size > 0,
        status: callbackStatus,
        transportFailed: failures.size > 0,
        phase,
        preAttemptSeen,
        orphanResponseSeen,
        trackingSaturated,
      };
    },
  };
}
