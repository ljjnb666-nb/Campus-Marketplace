import { spawn } from "node:child_process";
import path from "node:path";

import { test, expect } from "@playwright/test";
import { storageStatePath, uniqueTag } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";

/**
 * Phase 9C-02 — 9C02-E2E-01：errand deadline 过期 → 公开面立即 fail closed
 * + 真实 async-worker 在共享 durable queue 环境下 bounded eventual
 * materialize。
 *
 * 职责分层（Review Repair Round 2 / RB05 重新冻结）：
 *   - Integration（PRODUCTION-WORKER-ERRAND-DEADLINE-01）继续承担
 *     受控/空队列下 single --run-once 全链（schedule → enqueue → claim →
 *     handler → CANCELLED）的 INV-18 证明；
 *   - 本 E2E 证明的是共享队列下的正确性：多个 Playwright worker 共享同一
 *     E2E DB / AsyncJob queue，且多个 spec 会 spawn production async-worker
 *     ——本 spec 的 subprocess 不"拥有" scheduler enqueue，也不保证单轮
 *     claim 到目标 job。因此所有等待锚定 canonical durable intent identity
 *       dedupeKey = ERRAND_DEADLINE_EXPIRE:<errandId>
 *     通过有界真实 production worker progression 收敛到：
 *       exactly one canonical intent + COMPLETED + Task CANCELLED
 *       + zero ERRAND Order + replay safe。
 *
 * 红线（RB05 冻结）：
 *   - 不清空/不修改共享队列上其它 spec 的 job 数据；
 *   - 不串行化 suite、不改全局 retries、不改 worker batch size；
 *   - 进度只来自真实动作（run production worker → 查询 canonical 状态），
 *     禁止 sleep polling；
 *   - worker exit code != 0 属 production crash，立即 fail（不当竞争处理）；
 *   - public fail-closed 断言必须仍在任何 worker progression 之前。
 */

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/campus_e2e?schema=public";

/** 共享队列有界推进上界：worker batchSize=10、Playwright workers=2 下的小上界。 */
const MAX_WORKER_DRAIN_ROUNDS = 5;

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

/**
 * TEST-ONLY bounded progression（RB05）：每轮调用真实 production
 * async-worker --run-once（exit code != 0 立即 fail），然后以 canonical
 * dedupeKey + ErrandTask.status 判定是否收敛。每轮记录 test-only machine
 * evidence（round / exit / job exists / status / attempts / runAt / task
 * status——仅机器字段，无 payload 用户文本/secret），上界耗尽时随失败消息
 * 输出，便于定位。进度只来自真实 worker 动作，零 sleep。
 */
async function driveErrandExpiryToCompletion(errandId: string) {
  const dedupeKey = `ERRAND_DEADLINE_EXPIRE:${errandId}`;
  const rounds: Array<Record<string, unknown>> = [];

  for (let round = 1; round <= MAX_WORKER_DRAIN_ROUNDS; round += 1) {
    const result = await runProductionWorkerOnce();
    if (result.code !== 0) {
      throw new Error(
        `production async-worker exit=${result.code}（production crash 不属于共享队列竞争）\n` +
          `rounds=${JSON.stringify(rounds)}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
      );
    }

    const job = await e2eDb().asyncJob.findUnique({ where: { dedupeKey } });
    const task = await e2eDb().errandTask.findUniqueOrThrow({ where: { id: errandId } });
    rounds.push({
      round,
      workerExitCode: result.code,
      targetJobExists: job !== null,
      targetJobStatus: job?.status ?? null,
      targetJobAttempts: job?.attempts ?? null,
      targetJobRunAt: job?.runAt.toISOString() ?? null,
      targetTaskStatus: task.status,
    });

    if (job?.status === "COMPLETED" && task.status === "CANCELLED") {
      return { job, rounds };
    }
  }

  throw new Error(
    `bounded worker drain（${MAX_WORKER_DRAIN_ROUNDS} 轮）未收敛到 ` +
      `COMPLETED intent + CANCELLED Task\nrounds=${JSON.stringify(rounds)}`,
  );
}

function localDateTime(offsetHours: number): string {
  const date = new Date(Date.now() + offsetHours * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test("9C02-E2E-01：跑腿任务 deadline 过期 → 公开面立即隐藏 + async-worker 共享队列下 bounded eventual materialize 已取消", async ({ browser }) => {
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

  // ---------- 3. worker 前：公开面立即 fail closed（§17/§21 冻结位置）----------
  // 这段必须保持在任何 9C02 worker progression 之前——public correctness
  // independent of worker latency 的 E2E 证据
  await publisher.goto("/errands");
  await publisher.locator('input[name="q"]').first().fill(tag);
  await publisher.keyboard.press("Enter");
  await expect(publisher.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);

  // ---------- 4-5. 共享队列 bounded progression → canonical 终态 ----------
  // 本 subprocess 不拥有 scheduler enqueue（另一个合法 worker 可能已写入
  // intent），单轮也不保证 claim 到目标 job——以 canonical dedupeKey 为
  // authority，有界真实 worker 轮次收敛。
  const { job } = await driveErrandExpiryToCompletion(errandId);

  const task = await e2eDb().errandTask.findUniqueOrThrow({ where: { id: errandId } });
  expect(task.status).toBe("CANCELLED");
  expect(task.accepterId).toBeNull();

  // exactly-once canonical intent（RB05 §15：不只验证 Task）
  const jobs = await e2eDb().asyncJob.findMany({
    where: { dedupeKey: `ERRAND_DEADLINE_EXPIRE:${errandId}` },
  });
  expect(jobs).toHaveLength(1);
  expect(job.id).toBe(jobs[0]!.id);
  expect(jobs[0]!.kind).toBe("ERRAND_DEADLINE_EXPIRE");
  expect(jobs[0]!.schemaVersion).toBe(1);
  expect(jobs[0]!.payload).toEqual({ errandId });
  expect(jobs[0]!.status).toBe("COMPLETED");
  expect(jobs[0]!.completedAt).not.toBeNull();

  // 零新义务：expiry 不产生任何 ERRAND Order
  expect(await e2eDb().order.count({ where: { type: "ERRAND", errandTaskId: errandId } })).toBe(0);

  // ---------- 6. publisher /my/errands 终局 cancelled state ----------
  await publisher.goto("/my/errands");
  const card = publisher.locator("article", { hasText: title }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText("已取消").first()).toBeVisible();

  // ---------- 7. replay safety：再跑一次真实 worker（不要求 scheduler log）----------
  const replay = await runProductionWorkerOnce();
  expect(replay.code, `stdout=${replay.stdout}\nstderr=${replay.stderr}`).toBe(0);

  const jobsAfterReplay = await e2eDb().asyncJob.findMany({
    where: { dedupeKey: `ERRAND_DEADLINE_EXPIRE:${errandId}` },
  });
  expect(jobsAfterReplay).toHaveLength(1);
  expect(jobsAfterReplay[0]!.id).toBe(job.id);
  expect(jobsAfterReplay[0]!.status).toBe("COMPLETED");
  expect(jobsAfterReplay[0]!.completedAt!.getTime()).toBe(job.completedAt!.getTime());
  expect(jobsAfterReplay[0]!.attempts).toBe(job.attempts);

  const taskAfterReplay = await e2eDb().errandTask.findUniqueOrThrow({ where: { id: errandId } });
  expect(taskAfterReplay.status).toBe("CANCELLED");
  expect(await e2eDb().order.count({ where: { type: "ERRAND", errandTaskId: errandId } })).toBe(0);

  await publisherContext.close();
});
