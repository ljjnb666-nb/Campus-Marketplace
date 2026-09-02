/**
 * 备份新鲜度/状态健康检查（Phase 4 TASK 7）。
 *
 * 用法：npx tsx scripts/ops/backup-health-check.ts [--dir <backup-dir>]
 *        [--max-age-hours N] [--mode production|development]
 *
 * 读取 backup-postgres.sh 产生的机器可读状态产物 ${BACKUP_DIR}/backup-status.json
 * （只含非敏感 metadata），判定：
 *   LAST_BACKUP_STATUS / LAST_BACKUP_TIME / BACKUP_AGE_HOURS /
 *   CHECKSUM_STATUS / OFFSITE_STATUS
 *
 * 阈值契约：BACKUP_MAX_AGE_HOURS 可配置（默认 26，即"每天一备 + 2h 容忍"），
 * 不得把业务假设硬编码进检查逻辑。
 *
 * mode 契约：
 * - production：fail-closed。missing/malformed/failed/stale/offsite-failed
 *   → exit 1；offsite=not_configured → 新鲜度健康但 productionBackupReady=false
 *   （Phase 3B DEFERRED 语义：不得声称生产备份已就绪）。
 * - development：本地开发不强制生产备份；只报告事实，除非 --strict。
 *
 * 本脚本绝不读取/输出备份内容或任何凭据，仅解析 status JSON。
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

interface BackupStatus {
  status?: unknown;
  completedAt?: unknown;
  filename?: unknown;
  checksumVerified?: unknown;
  offsiteStatus?: unknown;
  stage?: unknown;
}

interface HealthReport {
  mode: string;
  backupDir: string;
  healthy: boolean;
  status: string;
  lastBackupTime: string | null;
  backupAgeHours: number | null;
  checksumVerified: boolean | null;
  offsiteStatus: string | null;
  productionBackupReady: boolean;
  reasons: string[];
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (key === "strict") {
        args.strict = "true";
      } else {
        args[key] = argv[i + 1] ?? "";
        i += 1;
      }
    }
  }
  return args;
}

/** 与 lib.sh 的 env contract 对齐：shell export 优先，其次 .env.production */
function loadEnvOverlay(file: string): void {
  if (!existsSync(file)) {
    return;
  }
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function evaluateBackupHealth(options: {
  backupDir: string;
  maxAgeHours: number;
  mode: string;
  strict: boolean;
}): { report: HealthReport; exitCode: number } {
  const { backupDir, maxAgeHours, mode } = options;
  const production = mode === "production";
  const statusFile = path.join(backupDir, "backup-status.json");

  const report: HealthReport = {
    mode,
    backupDir: backupDir || "(unset)",
    healthy: false,
    status: "unhealthy",
    lastBackupTime: null,
    backupAgeHours: null,
    checksumVerified: null,
    offsiteStatus: null,
    productionBackupReady: false,
    reasons: [],
  };

  const fail = (reason: string) => {
    report.reasons.push(reason);
    return { report, exitCode: production || options.strict ? 1 : 0 };
  };

  if (!backupDir) {
    return fail("BACKUP_DIR 未配置");
  }
  if (!existsSync(statusFile)) {
    return fail("缺少 backup-status.json（从未成功执行过备份，或状态产物被移除）");
  }

  let parsed: BackupStatus;
  try {
    parsed = JSON.parse(readFileSync(statusFile, "utf8")) as BackupStatus;
  } catch {
    return fail("backup-status.json 不是合法 JSON（状态产物损坏）");
  }

  if (parsed.status !== "success" && parsed.status !== "failed") {
    return fail(`status 字段非法：${typeof parsed.status === "string" ? "(非预期值)" : "(缺失)"}`);
  }
  report.status = parsed.status;

  const completedAt = asString(parsed.completedAt);
  if (!completedAt) {
    return fail("completedAt 缺失");
  }
  const completedMs = Date.parse(completedAt);
  if (Number.isNaN(completedMs)) {
    return fail("completedAt 不是可解析的时间戳");
  }
  report.lastBackupTime = new Date(completedMs).toISOString();
  report.backupAgeHours = Math.round(((Date.now() - completedMs) / 3_600_000) * 100) / 100;

  if (parsed.status === "failed") {
    return fail(`最近一次备份失败（stage=${asString(parsed.stage) ?? "unknown"}）`);
  }

  report.checksumVerified = parsed.checksumVerified === true;
  if (!report.checksumVerified) {
    return fail("最近一次备份未通过 checksum 校验");
  }

  report.offsiteStatus = asString(parsed.offsiteStatus);
  if (report.offsiteStatus === "failed") {
    return fail("异地备份失败（offsiteStatus=failed）");
  }

  if (report.backupAgeHours !== null && report.backupAgeHours > maxAgeHours) {
    return fail(`备份过期：BACKUP_AGE=${report.backupAgeHours}h > 阈值 ${maxAgeHours}h`);
  }

  // 新鲜度/校验/失败状态全部通过
  report.healthy = true;
  report.status = "healthy";

  if (report.offsiteStatus !== "success") {
    // not_configured：Phase 3B DEFERRED 语义——本地备份可用，但不得宣称
    // "生产备份就绪"（缺少异地副本，不满足 3-2-1）
    report.reasons.push("OFFSITE_NOT_CONFIGURED：无异地副本，productionBackupReady=false");
  } else {
    report.productionBackupReady = true;
  }

  return { report, exitCode: 0 };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  loadEnvOverlay(".env.production");

  const backupDir = args.dir ?? process.env.BACKUP_DIR ?? "";
  const maxAgeHours = Number(args["max-age-hours"] ?? process.env.BACKUP_MAX_AGE_HOURS ?? 26);
  const mode = args.mode ?? (process.env.NODE_ENV === "production" ? "production" : "development");

  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    console.error("backup-health-check: --max-age-hours 必须为正数");
    process.exit(1);
  }

  const { report, exitCode } = evaluateBackupHealth({
    backupDir,
    maxAgeHours,
    mode,
    strict: args.strict === "true",
  });

  // 单行 JSON：机器可读；reasons 只含非敏感事实描述
  console.log(JSON.stringify(report));
  process.exit(exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("backup-health-check.ts")) {
  main();
}
