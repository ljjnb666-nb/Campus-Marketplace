/**
 * 演练用 readiness 探测入口（observability-drill.sh 调用）。
 *
 * 直接复用生产探测实现 runReadinessChecks（同一代码路径，非 mock）：
 * 输出单行 JSON 摘要；not_ready → exit 1。
 * 依赖失败事件（dependency_health_failed）由 logger 输出到 stderr。
 */
import { runReadinessChecks } from "@/lib/dependency-health";

async function main(): Promise<void> {
  const report = await runReadinessChecks();

  console.log(
    JSON.stringify({
      status: report.status,
      dependencies: report.dependencies,
      checks: report.checks.map((c) => ({ dependency: c.dependency, status: c.status })),
    }),
  );

  process.exit(report.status === "not_ready" ? 1 : 0);
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      status: "probe_error",
      errorName: error instanceof Error ? error.name : "unknown",
    }),
  );
  process.exit(1);
});
