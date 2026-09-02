/**
 * METRICS_BEARER_TOKEN 单一安全校验契约（BLOCKER 3）。
 *
 * production-env-check（部署 preflight）与本路由（运行时 fail-closed）
 * 都调用本模块，规则只有一份：
 *
 * - 未设置/空：metrics 端点保持关闭（404）——允许的默认态；
 * - 非空时必须：>= 24 字符、不命中 unsafe defaults / 明显 placeholder、
 *   不等于 NEXTAUTH_SECRET（必须专用）。
 *
 * 校验结果只返回 reason（枚举短词），绝不返回/记录 token 值本身。
 */

/** 明显 placeholder / CI dummy / 危险默认值（值形态，小写包含匹配） */
const UNSAFE_TOKEN_PATTERNS = [
  "minioadmin",
  "changeme",
  "password",
  "123456",
  "placeholder",
  "dummy",
  "not-for-prod",
  "notforprod",
  "ci-only",
  "cionly",
  "test-token",
  "sample-token",
  "your-token",
  "your-token-here",
  "<token>",
  "token-here",
];

export type MetricsTokenDecision =
  | { open: false; reason: "unset" | "too_short" | "unsafe_default" | "reuses_nextauth_secret" }
  | { open: true };

export function decideMetricsToken(
  token: string | undefined | null,
  nextauthSecret: string | undefined | null,
): MetricsTokenDecision {
  if (typeof token !== "string" || token.length === 0) {
    return { open: false, reason: "unset" };
  }
  if (token.length < 24) {
    return { open: false, reason: "too_short" };
  }
  const lowered = token.toLowerCase();
  if (UNSAFE_TOKEN_PATTERNS.some((pattern) => lowered.includes(pattern))) {
    return { open: false, reason: "unsafe_default" };
  }
  if (typeof nextauthSecret === "string" && nextauthSecret.length > 0 && token === nextauthSecret) {
    return { open: false, reason: "reuses_nextauth_secret" };
  }
  return { open: true };
}

/** production-env-check 用：token 未设置视为可选关闭；设置则必须安全。 */
export function metricsTokenEnvChecks(vars: Record<string, string | undefined>): {
  name: string;
  ok: boolean;
  message?: string;
}[] {
  const token = vars.METRICS_BEARER_TOKEN ?? "";
  const decision = decideMetricsToken(token, vars.NEXTAUTH_SECRET ?? "");
  // open=true 不应出现在此处（open=true 意味着 unset 之外的安全 token，
  // 而 unset 已在上面 return；此处访问统一经 reason 变量，避免 union 收窄问题）
  const reason: "unset" | "too_short" | "unsafe_default" | "reuses_nextauth_secret" =
    decision.open ? "unset" : decision.reason;

  if (reason === "unset") {
    return [
      { name: "METRICS_BEARER_TOKEN.strength", ok: true, message: "未设置：metrics 端点保持关闭（允许）" },
      { name: "METRICS_BEARER_TOKEN.dedicated", ok: true, message: "未设置：metrics 端点保持关闭（允许）" },
    ];
  }

  const strengthFail =
    reason === "too_short"
      ? "METRICS_BEARER_TOKEN 短于 24 字符"
      : reason === "unsafe_default"
        ? "METRICS_BEARER_TOKEN 命中危险默认值/placeholder 形态"
        : undefined;
  const reused = reason === "reuses_nextauth_secret";
  return [
    {
      name: "METRICS_BEARER_TOKEN.strength",
      ok: strengthFail === undefined,
      message: strengthFail,
    },
    {
      name: "METRICS_BEARER_TOKEN.dedicated",
      ok: !reused,
      message: reused ? "禁止复用 NEXTAUTH_SECRET（必须专用）" : undefined,
    },
  ];
}
