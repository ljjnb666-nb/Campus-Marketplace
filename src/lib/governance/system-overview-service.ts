import { runReadinessChecks } from "@/lib/dependency-health";

/**
 * Phase 7H：/governance/system 运营级系统概览读模型（READ-ONLY，SSOT 复用）。
 *
 * 硬合同（Planning §12-§16/§42/§44/§46 冻结）：
 * - readiness truth 唯一来源 = canonical runReadinessChecks()（database/
 *   redis/storage 探测 + ready/degraded/not_ready 聚合）。本模块绝不重新
 *   实现 DB ping / Redis readiness / S3 health 的第二套语义；
 * - FAIL-SOFT（§16/§46）：依赖降级绝不允许页面 500。readiness 框架自身
 *   异常时输出 canonical enum 的最坏组合（database failed / redis degraded /
 *   storage failed → not_ready），绝不发明 warning/critical 第二套 taxonomy；
 * - 安全边界（§14/§15）：DTO 仅 release 标识 + status enum——绝不包含
 *   DATABASE_URL / Redis 主机 / S3 endpoint / 凭据 / metrics token /
 *   原始异常 / 文件路径 / IP；dependency error 只能输出 safe status enum；
 *   绝不读取 /api/internal/metrics 或 METRICS_BEARER_TOKEN；
 * - release 来源 = process.env.RELEASE_SHA（Dockerfile GIT_SHA 注入链，
 *   与 /api/health 的 release 字段同一来源，缺省 "dev"）。
 */

export type SystemOverviewDependencyStatus = "ok" | "degraded" | "failed";

export type SystemOverviewDto = {
  /** 发布标识（构建注入；本地/缺省为 "dev"） */
  release: string;
  /** canonical readiness 顶层状态（ready / degraded / not_ready） */
  status: "ready" | "degraded" | "not_ready";
  dependencies: {
    database: SystemOverviewDependencyStatus;
    redis: SystemOverviewDependencyStatus;
    storage: SystemOverviewDependencyStatus;
  };
};

export async function loadSystemOverview(): Promise<SystemOverviewDto> {
  const release = process.env.RELEASE_SHA ?? "dev";

  try {
    const report = await runReadinessChecks();
    return {
      release,
      status: report.status,
      dependencies: {
        database: report.dependencies.database,
        redis: report.dependencies.redis,
        storage: report.dependencies.storage,
      },
    };
  } catch {
    // fail-soft：readiness 框架自身异常（如依赖探测器抛出预期外错误）时
    // 页面降级为 not_ready 全故障组合——canonical enum 语义内表达，
    // 绝不让 React 页面因依赖状态 throw 500（§16）。
    return {
      release,
      status: "not_ready",
      dependencies: { database: "failed", redis: "degraded", storage: "failed" },
    };
  }
}
