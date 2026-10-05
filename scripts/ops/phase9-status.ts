/**
 * Phase 9 ops status CLI（§33/§36/§37，只读 machine-only surface）。
 *
 *   npm run ops:phase9-status            # 打印 snapshot JSON（result=PASS）
 *   npm run ops:phase9-status -- --strict # structural invariant violation
 *                                          → result=FAIL + exit 1
 *
 * 输出契约：
 * - 单个 JSON object（stdout），只含 counts / ages / safe machine status；
 *   绝不输出 payload / destination / 邮箱 / objectKey / bucket /
 *   providerMessageId / dedupeKey raw / lastErrorMessage / 连接串
 *  （PHASE9-OPS-NO-SECRET-01 以 stdout 全量捕获锁定）。
 * - dead letter 存在 → attentionRequired=true（operational attention，需要
 *   人看），但 result 仍 PASS——dead letter 不是"平台不可运行"（§36）。
 * - --strict：仅 structural inconsistency（§37 invariant violation）才
 *   FAIL + exit 1；绝不自动修复任何状态（§38）。
 *
 * 本 CLI 绝不替代 /api/ready（§35：readiness 只看基础依赖，dead letter
 * 不翻转 readiness）。
 */

import "dotenv/config";

import { getPhase9OpsSnapshot, getPhase9StructuralInconsistencies } from "@/lib/async/phase9-ops";

async function main() {
  const strict = process.argv.includes("--strict");

  const snapshot = await getPhase9OpsSnapshot();
  const inconsistencies = strict ? await getPhase9StructuralInconsistencies() : null;

  const failed = inconsistencies?.any === true;

  console.log(
    JSON.stringify(
      {
        result: failed ? "FAIL" : "PASS",
        ...snapshot,
        ...(inconsistencies ? { structuralInconsistencies: inconsistencies } : {}),
      },
      null,
      2,
    ),
  );

  if (failed) {
    process.exit(1);
  }
}

main().catch((error) => {
  // 绝不打印 error.message（可能内嵌连接串/内部细节）；errorName only
  console.error(
    JSON.stringify({
      result: "FAIL",
      errorName: error instanceof Error ? error.name : "unknown",
    }),
  );
  process.exit(1);
});
