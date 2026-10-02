import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Phase 9B static gate（§19/§50/§92）：canonical notification domain 之外，
 * production 源码禁止任何 Notification 直接写入。
 *
 * - 允许：src/lib/notifications/**（canonical domain 实现）、读/标记已读
 *   （updateMany/update/deleteMany）、tests、migration；
 * - 禁止：notification.create / notification.createMany / 对 "Notification"
 *   表的 raw INSERT（含 prisma.$executeRaw 路径）；
 * - 新增直接 writer → CI fail（merge blocker：DIRECT_NOTIFICATION_WRITERS
 *   _OUTSIDE_DOMAIN = 0）。
 *
 * 本 gate 自校验（sanity）：扫描器对 canonical domain 自身的 createMany
 * 必须命中——防止正则退化为永远通过的空扫描。
 */

const REPO_ROOT = path.resolve(process.cwd());

const SCAN_ROOTS = [path.join(REPO_ROOT, "src")];

/** production 代码 = src 下全部 TS/TSX（colocated *.test.ts(x) 除外）。 */
const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);

const DOMAIN_ROOT = path.join(REPO_ROOT, "src", "lib", "notifications");

const FORBIDDEN_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "notification.create(", pattern: /\.notification\.create\s*\(/ },
  { name: "notification.createMany(", pattern: /\.notification\.createMany\s*\(/ },
  { name: 'raw INSERT INTO "Notification"', pattern: /INSERT\s+INTO\s+"Notification"/i },
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!SCAN_EXTENSIONS.has(path.extname(entry))) continue;
    // 测试文件允许直连（fixture/断言不进 production 行为面）
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

function scanViolations(): Array<{ file: string; line: number; name: string }> {
  const violations: Array<{ file: string; line: number; name: string }> = [];
  for (const root of SCAN_ROOTS) {
    for (const file of listSourceFiles(root)) {
      if (file.startsWith(DOMAIN_ROOT + path.sep) || file === DOMAIN_ROOT) continue;
      const content = readFileSync(file, "utf8");
      const lines = content.split(/\r?\n/);
      for (const { name, pattern } of FORBIDDEN_PATTERNS) {
        for (let i = 0; i < lines.length; i += 1) {
          if (pattern.test(lines[i])) {
            violations.push({ file: path.relative(REPO_ROOT, file), line: i + 1, name });
          }
        }
      }
    }
  }
  return violations;
}

describe("Phase 9B direct-writer static gate（§19/§50/§92）", () => {
  it("canonical notification domain 之外零 Notification 直接写入", () => {
    expect(scanViolations()).toEqual([]);
  });

  it("gate 自校验：扫描器在 canonical domain 内必须命中写入原语（防空转）", () => {
    const serviceSource = readFileSync(
      path.join(DOMAIN_ROOT, "notification-service.ts"),
      "utf8",
    );
    expect(/\.notification\.createMany\s*\(/.test(serviceSource)).toBe(true);
  });

  it("legacy repository 已无 production create 导出（§20）", () => {
    const repoSource = readFileSync(
      path.join(REPO_ROOT, "src", "repositories", "notification-repository.ts"),
      "utf8",
    );
    expect(/export\s+(async\s+)?function\s+createNotification/.test(repoSource)).toBe(false);
    expect(/export\s+(async\s+)?function\s+createNotifications/.test(repoSource)).toBe(false);
    expect(repoSource).toContain("getNotificationsForUser");
    expect(repoSource).toContain("getUnreadNotificationCount");
  });
});
