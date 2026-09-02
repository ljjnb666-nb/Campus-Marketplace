import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { evaluateBackupHealth } from "../../scripts/ops/backup-health-check";

/**
 * Phase 4 TASK 7 + BLOCKER 4：备份新鲜度/状态/完整性判定。
 * BACKUP_FRESHNESS_TEST + BACKUP_CHECKSUM_CORRUPTION_TEST：
 * health 不盲信状态布尔——真实校验 dump 存在且当前内容与 checksum 一致。
 */
describe("backup-health-check", () => {
  let dir: string;
  const DUMP_NAME = "campus-20260902-000000.dump";

  beforeEach(() => {
    dir = path.join(tmpdir(), `campus-backup-health-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** 写真实 dump 文件 + 正确的 .sha256 + fresh status（内容可后续被破坏） */
  function writeRealBackup(overrides: {
    dumpContent?: Buffer;
    checksumFileContent?: string;
    statusOverrides?: Record<string, unknown>;
    omitDump?: boolean;
    omitChecksum?: boolean;
  } = {}): Buffer {
    const dumpContent = overrides.dumpContent ?? Buffer.from("PGDMP-fake-backup-payload-for-sandbox");
    if (!overrides.omitDump) {
      writeFileSync(path.join(dir, DUMP_NAME), dumpContent);
    }
    const actualChecksum = createHash("sha256").update(dumpContent).digest("hex");
    if (!overrides.omitChecksum) {
      writeFileSync(
        path.join(dir, `${DUMP_NAME}.sha256`),
        overrides.checksumFileContent ?? `${actualChecksum}  ${DUMP_NAME}\n`,
      );
    }
    writeFileSync(
      path.join(dir, "backup-status.json"),
      JSON.stringify({
        status: "success",
        completedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        filename: DUMP_NAME,
        checksumVerified: true,
        offsiteStatus: "success",
        stage: "complete",
        ...overrides.statusOverrides,
      }),
    );
    return dumpContent;
  }

  function hoursAgo(hours: number): string {
    return new Date(Date.now() - hours * 3_600_000).toISOString();
  }

  async function evaluate(overrides: { maxAgeHours?: number; mode?: string } = {}) {
    return evaluateBackupHealth({
      backupDir: dir,
      maxAgeHours: overrides.maxAgeHours ?? 26,
      mode: overrides.mode ?? "production",
      strict: false,
    });
  }

  it("valid dump + valid checksum + fresh + offsite success → healthy 且 productionBackupReady", async () => {
    writeRealBackup();

    const { report, exitCode } = await evaluate();

    expect(exitCode).toBe(0);
    expect(report.healthy).toBe(true);
    expect(report.productionBackupReady).toBe(true);
  });

  it("BACKUP_CHECKSUM_CORRUPTION_TEST：dump 备份后被修改 → unhealthy（不盲信状态布尔）", async () => {
    const original = writeRealBackup();
    // 备份成功之后 dump 被损坏/篡改
    writeFileSync(path.join(dir, DUMP_NAME), Buffer.concat([original, Buffer.from("corrupted")]));

    const { report, exitCode } = await evaluate();

    expect(exitCode).toBe(1);
    expect(report.healthy).toBe(false);
    expect(report.reasons.join()).toMatch(/不一致/);
  });

  it("BACKUP_CHECKSUM_CORRUPTION_TEST：checksum 文件被修改 → unhealthy", async () => {
    writeRealBackup({
      checksumFileContent: `${"f".repeat(64)}  ${DUMP_NAME}\n`,
    });

    const { report, exitCode } = await evaluate();

    expect(exitCode).toBe(1);
    expect(report.healthy).toBe(false);
  });

  it("BACKUP_CHECKSUM_CORRUPTION_TEST：dump 缺失 → unhealthy", async () => {
    writeRealBackup({ omitDump: true });

    const { report, exitCode } = await evaluate();

    expect(exitCode).toBe(1);
    expect(report.reasons.join()).toMatch(/dump 文件缺失/);
  });

  it("BACKUP_CHECKSUM_CORRUPTION_TEST：checksum 文件缺失 → unhealthy", async () => {
    writeRealBackup({ omitChecksum: true });

    const { report, exitCode } = await evaluate();

    expect(exitCode).toBe(1);
    expect(report.reasons.join()).toMatch(/checksum 文件缺失/);
  });

  it("stale backup → unhealthy（production fail-closed）", async () => {
    writeRealBackup({
      statusOverrides: { completedAt: hoursAgo(48) },
    });

    const { report, exitCode } = await evaluate();

    expect(exitCode).toBe(1);
    expect(report.healthy).toBe(false);
    expect(report.reasons.join()).toMatch(/过期/);
  });

  it("阈值可配置：48h 老备份在 72h 阈值下仍 healthy", async () => {
    writeRealBackup({ statusOverrides: { completedAt: hoursAgo(48) } });

    const { report, exitCode } = await evaluate({ maxAgeHours: 72 });

    expect(exitCode).toBe(0);
    expect(report.healthy).toBe(true);
  });

  it("failed backup → unhealthy，stage 透出", async () => {
    writeRealBackup({ statusOverrides: { status: "failed", stage: "offsite" } });

    const { report, exitCode } = await evaluate();

    expect(exitCode).toBe(1);
    expect(report.reasons.join()).toMatch(/备份失败/);
    expect(report.reasons.join()).toMatch(/offsite/);
  });

  it("malformed status → unhealthy", async () => {
    writeFileSync(path.join(dir, "backup-status.json"), JSON.stringify({ nonsense: true }));

    const { report, exitCode } = await evaluate();

    expect(exitCode).toBe(1);
    expect(report.healthy).toBe(false);
  });

  it("missing status → unhealthy", async () => {
    const { exitCode, report } = await evaluate();

    expect(exitCode).toBe(1);
    expect(report.reasons.join()).toMatch(/backup-status/);
  });

  it("offsite configured but failed → unhealthy", async () => {
    writeRealBackup({ statusOverrides: { offsiteStatus: "failed" } });

    const { exitCode, report } = await evaluate();

    expect(exitCode).toBe(1);
    expect(report.reasons.join()).toMatch(/异地备份失败/);
  });

  it("offsite not_configured → 本地备份 healthy 但 productionBackupReady=false（3B DEFERRED 语义）", async () => {
    writeRealBackup({ statusOverrides: { offsiteStatus: "not_configured" } });

    const { report, exitCode } = await evaluate();

    expect(exitCode).toBe(0);
    expect(report.healthy).toBe(true);
    expect(report.productionBackupReady).toBe(false);
    expect(report.reasons.join()).toMatch(/OFFSITE_NOT_CONFIGURED/);
  });

  it("checksumVerified=false 状态 → unhealthy", async () => {
    writeRealBackup({ statusOverrides: { checksumVerified: false } });

    const { exitCode } = await evaluate();

    expect(exitCode).toBe(1);
  });

  it("development mode：missing backup 报告事实但不阻断（exit 0）", async () => {
    const { exitCode, report } = await evaluate({ mode: "development" });

    expect(exitCode).toBe(0);
    expect(report.healthy).toBe(false);
  });

  it("development --strict：missing backup 阻断（exit 1）", async () => {
    const { exitCode } = await evaluateBackupHealth({
      backupDir: dir,
      maxAgeHours: 26,
      mode: "development",
      strict: true,
    });

    expect(exitCode).toBe(1);
  });

  it("BACKUP_DIR 未配置 → unhealthy", async () => {
    const { report, exitCode } = await evaluateBackupHealth({
      backupDir: "",
      maxAgeHours: 26,
      mode: "development",
      strict: false,
    });

    expect(exitCode).toBe(0);
    expect(report.reasons.join()).toMatch(/BACKUP_DIR/);
  });
});
