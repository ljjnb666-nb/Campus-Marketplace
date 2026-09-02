import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { evaluateBackupHealth } from "../../scripts/ops/backup-health-check";

/**
 * Phase 4 TASK 7：备份新鲜度/状态判定（BACKUP_FRESHNESS_TEST）。
 * 覆盖：recent healthy / stale / failed / malformed / missing /
 * offsite failed / offsite not_configured / checksum 未验证 / 阈值可配置。
 */
describe("backup-health-check", () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(tmpdir(), `campus-backup-health-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeStatus(payload: unknown) {
    writeFileSync(path.join(dir, "backup-status.json"), JSON.stringify(payload));
  }

  function hoursAgo(hours: number): string {
    return new Date(Date.now() - hours * 3_600_000).toISOString();
  }

  const fresh = {
    status: "success",
    completedAt: hoursAgo(2),
    filename: "campus-20260901-000000.dump",
    checksumVerified: true,
    offsiteStatus: "success",
  };

  it("recent + verified + offsite success → healthy 且 productionBackupReady", () => {
    writeStatus(fresh);

    const { report, exitCode } = evaluateBackupHealth({
      backupDir: dir,
      maxAgeHours: 26,
      mode: "production",
      strict: false,
    });

    expect(exitCode).toBe(0);
    expect(report.healthy).toBe(true);
    expect(report.backupAgeHours).toBeLessThan(3);
    expect(report.productionBackupReady).toBe(true);
  });

  it("stale backup → unhealthy（production fail-closed）", () => {
    writeStatus({ ...fresh, completedAt: hoursAgo(48) });

    const { report, exitCode } = evaluateBackupHealth({
      backupDir: dir,
      maxAgeHours: 26,
      mode: "production",
      strict: false,
    });

    expect(exitCode).toBe(1);
    expect(report.healthy).toBe(false);
    expect(report.reasons.join()).toMatch(/过期/);
  });

  it("阈值可配置：48h 老备份在 72h 阈值下仍 healthy", () => {
    writeStatus({ ...fresh, completedAt: hoursAgo(48) });

    const { report, exitCode } = evaluateBackupHealth({
      backupDir: dir,
      maxAgeHours: 72,
      mode: "production",
      strict: false,
    });

    expect(exitCode).toBe(0);
    expect(report.healthy).toBe(true);
  });

  it("failed backup → unhealthy，stage 透出", () => {
    writeStatus({ ...fresh, status: "failed", stage: "offsite" });

    const { report, exitCode } = evaluateBackupHealth({
      backupDir: dir,
      maxAgeHours: 26,
      mode: "production",
      strict: false,
    });

    expect(exitCode).toBe(1);
    expect(report.reasons.join()).toMatch(/备份失败/);
    expect(report.reasons.join()).toMatch(/offsite/);
  });

  it("malformed status → unhealthy", () => {
    writeStatus({ nonsense: true });

    const { exitCode, report } = evaluateBackupHealth({
      backupDir: dir,
      maxAgeHours: 26,
      mode: "production",
      strict: false,
    });

    expect(exitCode).toBe(1);
    expect(report.healthy).toBe(false);
  });

  it("missing status → unhealthy", () => {
    const { exitCode, report } = evaluateBackupHealth({
      backupDir: dir,
      maxAgeHours: 26,
      mode: "production",
      strict: false,
    });

    expect(exitCode).toBe(1);
    expect(report.reasons.join()).toMatch(/backup-status/);
  });

  it("offsite configured but failed → unhealthy", () => {
    writeStatus({ ...fresh, offsiteStatus: "failed" });

    const { exitCode, report } = evaluateBackupHealth({
      backupDir: dir,
      maxAgeHours: 26,
      mode: "production",
      strict: false,
    });

    expect(exitCode).toBe(1);
    expect(report.reasons.join()).toMatch(/异地备份失败/);
  });

  it("offsite not_configured → 本地备份 healthy 但 productionBackupReady=false（3B DEFERRED 语义）", () => {
    writeStatus({ ...fresh, offsiteStatus: "not_configured" });

    const { report, exitCode } = evaluateBackupHealth({
      backupDir: dir,
      maxAgeHours: 26,
      mode: "production",
      strict: false,
    });

    expect(exitCode).toBe(0);
    expect(report.healthy).toBe(true);
    expect(report.productionBackupReady).toBe(false);
    expect(report.reasons.join()).toMatch(/OFFSITE_NOT_CONFIGURED/);
  });

  it("checksum 未验证 → unhealthy", () => {
    writeStatus({ ...fresh, checksumVerified: false });

    const { exitCode } = evaluateBackupHealth({
      backupDir: dir,
      maxAgeHours: 26,
      mode: "production",
      strict: false,
    });

    expect(exitCode).toBe(1);
  });

  it("development mode：missing backup 报告事实但不阻断（exit 0）", () => {
    const { exitCode, report } = evaluateBackupHealth({
      backupDir: dir,
      maxAgeHours: 26,
      mode: "development",
      strict: false,
    });

    expect(exitCode).toBe(0);
    expect(report.healthy).toBe(false);
  });

  it("development --strict：missing backup 阻断（exit 1）", () => {
    const { exitCode } = evaluateBackupHealth({
      backupDir: dir,
      maxAgeHours: 26,
      mode: "development",
      strict: true,
    });

    expect(exitCode).toBe(1);
  });

  it("BACKUP_DIR 未配置 → unhealthy", () => {
    const { exitCode, report } = evaluateBackupHealth({
      backupDir: "",
      maxAgeHours: 26,
      mode: "development",
      strict: false,
    });

    expect(exitCode).toBe(0);
    expect(report.reasons.join()).toMatch(/BACKUP_DIR/);
  });
});
