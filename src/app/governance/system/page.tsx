import {
  requireOperationsOverviewAdmin,
} from "@/lib/governance/operations-overview-access";
import {
  loadSystemOverview,
  type SystemOverviewDependencyStatus,
} from "@/lib/governance/system-overview-service";

export const dynamic = "force-dynamic";

const DEPENDENCY_LABELS: Record<string, string> = {
  database: "数据库",
  redis: "Redis",
  storage: "对象存储",
};

const STATUS_LABELS: Record<string, string> = {
  ok: "正常",
  degraded: "降级",
  failed: "故障",
  ready: "就绪",
  not_ready: "未就绪",
};

function statusBadgeClass(status: string): string {
  if (status === "ok" || status === "ready") {
    return "rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700";
  }
  if (status === "degraded") {
    return "rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700";
  }
  return "rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700";
}

function renderStatus(status: SystemOverviewDependencyStatus | "ready" | "not_ready") {
  const label = STATUS_LABELS[status] ?? status;
  return <span className={statusBadgeClass(status)}>{label}</span>;
}

/**
 * Phase 7H：/governance/system 运营级系统概览（GLOBAL operations.overview
 * ONLY；read-only；force-dynamic）。
 *
 * - 边界（§42）：本页是 runtime/dependency operational state，≠ /governance
 *   的 operations workload，≠ /governance/campuses 的 tenant administration；
 * - 数据 = canonical readiness report（§13 SSOT 复用，fail-soft——依赖
 *   降级/故障只改变展示的 safe status enum，绝不使页面本身 500）；
 * - 安全（§14/§15）：仅 release 标识 + status enum，无任何端点/凭据/
 *   原始错误/路径；不是 Grafana/metrics 替代品，也不消费 metrics token。
 */
export default async function GovernanceSystemPage() {
  await requireOperationsOverviewAdmin();

  const overview = await loadSystemOverview();

  const dependencyRows = [
    { key: "database", status: overview.dependencies.database },
    { key: "redis", status: overview.dependencies.redis },
    { key: "storage", status: overview.dependencies.storage },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">系统状态</h1>
        <p className="mt-2 text-sm text-slate-600">
          平台运行状态概览：只读展示发布标识与依赖就绪状态。不含任何端点、凭据或原始错误信息。
        </p>
      </div>

      <section
        aria-label="平台就绪状态"
        className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-medium text-slate-500">平台就绪状态</h2>
          {renderStatus(overview.status)}
        </div>
        <p className="mt-3 text-sm text-slate-600">
          发布版本：<span data-testid="release-sha">{overview.release}</span>
        </p>
      </section>

      <section aria-label="依赖状态" className="mt-6">
        <h2 className="mb-4 text-xl font-semibold text-slate-950">依赖状态</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {dependencyRows.map((row) => (
            <div
              key={row.key}
              className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
            >
              <p className="text-sm text-slate-500">
                {DEPENDENCY_LABELS[row.key] ?? row.key}
              </p>
              <div className="mt-3">{renderStatus(row.status)}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
