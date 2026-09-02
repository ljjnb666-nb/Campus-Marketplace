/**
 * 演练用探测入口（observability-drill.sh 调用）。
 *
 * --check readiness（默认）：复用生产探测实现 runReadinessChecks（同一代码
 *   路径，非 mock）；输出单行 JSON；not_ready → exit 1。
 * --check health：直接调用 /api/health 路由的 GET handler（liveness）。
 *   真 liveness 不依赖任何依赖——DB 停机时该调用仍必须 200
 *   （若 handler 意外访问依赖，容器停机时此调用会失败/超时，drill 抓住）。
 *
 * 依赖失败事件（dependency_health_failed）由 logger 输出到 stderr。
 */
import { GET as healthGET } from "@/app/api/health/route";
import { runReadinessChecks } from "@/lib/dependency-health";

async function probeHealth(): Promise<number> {
  const response = await healthGET(new Request("http://localhost/api/health"));
  const body = (await response.json()) as { status?: string; release?: string };
  console.log(JSON.stringify({ check: "health", httpStatus: response.status, ...body }));
  return response.status;
}

async function probeReadiness(): Promise<number> {
  const report = await runReadinessChecks();
  console.log(
    JSON.stringify({
      check: "readiness",
      status: report.status,
      dependencies: report.dependencies,
      checks: report.checks.map((c) => ({ dependency: c.dependency, status: c.status })),
    }),
  );
  return report.status === "not_ready" ? 503 : 200;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check")
    ? process.argv[process.argv.indexOf("--check") + 1]
    : "readiness";

  const httpStatus = check === "health" ? await probeHealth() : await probeReadiness();
  process.exit(httpStatus === 200 ? 0 : 1);
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
