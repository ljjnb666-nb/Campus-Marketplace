import { spawn } from "node:child_process";
import path from "node:path";

import { test, expect } from "@playwright/test";
import { storageStatePath, uniqueTag } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";

/**
 * Phase 9C-02 — 9C02-E2E-01：errand deadline 过期 → 公开面立即 fail closed
 * + 真实 async-worker 单次 invocation materialize CANCELLED。
 *
 * 流程（任务书 §27）：
 *   1. publisher 经正常 UI 创建 future-deadline errand；
 *   2. TEST-ONLY DB advance：只把 deadline 推到过去（禁止直接改 status /
 *      禁止手工插 AsyncJob）；
 *   3. worker 运行前：/errands 公开列表已不可发现该任务（query-time
 *      fail closed，不依赖 scheduler）；
 *   4. 调用真实 production worker entrypoint（scripts/ops/async-worker.ts
 *      --run-once；与 compose async-worker 服务同一入口）；
 *   5. DB：Task = CANCELLED、expiry AsyncJob = COMPLETED（canonical
 *      dedupeKey ERRAND_DEADLINE_EXPIRE:<errandId>）；
 *   6. publisher /my/errands 看到终局「已取消」；
 *   7. 再跑 worker：零 duplicate job、零二次 mutation。
 */

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/campus_e2e?schema=public";

function runProductionWorkerOnce(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(process.cwd(), "scripts", "ops", "async-worker.ts"),
        "--run-once",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "test",
          DATABASE_URL: E2E_DATABASE_URL,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function localDateTime(offsetHours: number): string {
  const date = new Date(Date.now() + offsetHours * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test("9C02-E2E-01：跑腿任务 deadline 过期 → 公开面立即隐藏 + async-worker 自动 materialize 已取消", async ({ browser }) => {
  test.setTimeout(180_000);
  const tag = uniqueTag("p9c02");
  const title = `9C02过期任务 ${tag}`;

  // ---------- 1. publisher 经正常 UI 创建 future-deadline errand ----------
  const publisherContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const publisher = await publisherContext.newPage();
  await publisher.goto("/errands/new");
  await publisher.locator('input[name="title"]').first().fill(title);
  await publisher.locator('textarea[name="description"]').first().fill(`E2E Phase 9C-02 ${tag}`);
  await publisher.locator('select[name="categoryId"]').first().selectOption({ label: "代取快递" });
  await publisher.locator('input[name="reward"]').first().fill("8.8");
  await publisher.locator('input[name="pickupLocation"]').first().fill("E2E 9C02 取件点");
  await publisher.locator('input[name="deliveryLocation"]').first().fill("E2E 9C02 送达点");
  await publisher.locator('input[name="deadline"]').first().fill(localDateTime(2));
  await publisher.getByRole("button", { name: "发布任务" }).first().click();
  await expect(publisher.getByRole("heading", { level: 1, name: title })).toBeVisible({
    timeout: 30_000,
  });
  const errandId = new URL(publisher.url()).pathname.split("/").pop() ?? "";

  const errand = await e2eDb().errandTask.findUniqueOrThrow({ where: { id: errandId } });
  expect(errand.status).toBe("OPEN");
  expect(errand.deadline.getTime()).toBeGreaterThan(Date.now());

  // ---------- 2. TEST-ONLY DEADLINE ADVANCE（仅推进 deadline 字段）----------
  // 绝不直接修改 status；绝不手工插 AsyncJob——materialize 只能由
  // canonical lifecycle（expireErrandDeadlineTx 经真实 worker）写入
  await e2eDb().errandTask.update({
    where: { id: errandId },
    data: { deadline: new Date(Date.now() - 1000) },
  });

  // ---------- 3. worker 前：公开面立即 fail closed（§21）----------
  await publisher.goto("/errands");
  await publisher.locator('input[name="q"]').first().fill(tag);
  await publisher.keyboard.press("Enter");
  await expect(publisher.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);

  // ---------- 4-5. 真实 production worker --run-once 单次 materialize ----------
  const result = await runProductionWorkerOnce();
  expect(result.code, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
  expect(result.stdout).toContain("errand_deadline_scheduler_cycle");

  await expect
    .poll(async () => (await e2eDb().errandTask.findUniqueOrThrow({ where: { id: errandId } })).status)
    .toBe("CANCELLED");

  const jobs = await e2eDb().asyncJob.findMany({
    where: { dedupeKey: `ERRAND_DEADLINE_EXPIRE:${errandId}` },
  });
  expect(jobs).toHaveLength(1);
  const job = jobs[0]!;
  expect(job.kind).toBe("ERRAND_DEADLINE_EXPIRE");
  expect(job.schemaVersion).toBe(1);
  expect(job.payload).toEqual({ errandId });
  expect(job.status).toBe("COMPLETED");
  expect(job.completedAt).not.toBeNull();

  // 零新义务：expiry 不产生任何 ERRAND Order
  expect(await e2eDb().order.count({ where: { type: "ERRAND", errandTaskId: errandId } })).toBe(0);

  // ---------- 6. publisher /my/errands 终局 cancelled state ----------
  await publisher.goto("/my/errands");
  const card = publisher.locator("article", { hasText: title }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText("已取消").first()).toBeVisible();

  // ---------- 7. 复跑 worker：零 duplicate job、零二次 mutation ----------
  const replay = await runProductionWorkerOnce();
  expect(replay.code, `stdout=${replay.stdout}\nstderr=${replay.stderr}`).toBe(0);

  const jobsAfterReplay = await e2eDb().asyncJob.findMany({
    where: { dedupeKey: `ERRAND_DEADLINE_EXPIRE:${errandId}` },
  });
  expect(jobsAfterReplay).toHaveLength(1);
  expect(jobsAfterReplay[0]!.id).toBe(job.id);
  expect(jobsAfterReplay[0]!.completedAt!.getTime()).toBe(job.completedAt!.getTime());
  expect(jobsAfterReplay[0]!.attempts).toBe(1);

  const taskAfterReplay = await e2eDb().errandTask.findUniqueOrThrow({ where: { id: errandId } });
  expect(taskAfterReplay.status).toBe("CANCELLED");

  await publisherContext.close();
});
