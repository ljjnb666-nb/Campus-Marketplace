import { spawn } from "node:child_process";
import path from "node:path";

import { test, expect } from "@playwright/test";
import { E2E_ACCOUNTS, storageStatePath, uniqueTag } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";
import { flushRateLimits } from "./helpers/rate-limit";
import { loginViaUI } from "./helpers/auth";
import { withE2EAsyncWorkerProtocolLock } from "./helpers/async-worker-lock";

/**
 * Phase 9C-03 — 9C03-E2E-01：durable async data export 全链
 * （真实 UI + 真实 production async-worker + 真实 MinIO artifact）。
 *
 * 流程（任务书 §56）：
 *   新用户正常注册/登录（避免与并行 spec 竞争共享 buyer 的 active 导出）
 *   → fixture：与卖家的 COMPLETED 订单 + 卖家私密手机号（跨用户断言锚点）
 *   → UI 点击"导出我的数据" → POST 202 → UI 显示正在排队/正在生成
 *   → RB06 protocol lock 内：真实 production async-worker（--run-once）有界
 *     多轮驱动（Step A prepare → RESCHEDULE → Step B generate，两轮为常态）
 *   → request COMPLETED → UI 自动显示下载链接 + 有效期
 *   → 下载 → JSON parse → account.id == 当前用户
 *   → 他人私密字段/内部秘密/存储定位符结构性缺席
 *
 * 最终断言：恰一条 request（COMPLETED）+ 恰一条 job（COMPLETED）+
 * artifact READY（sha256/expiresAt 登记）；create/list/download 三个
 * browser-visible 面均不含 bucket/objectKey/presignedUrl/sha256。
 */

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/campus_e2e?schema=public";

const FORBIDDEN_INTERNAL_KEYS = [
  "passwordHash",
  "sessionToken",
  "objectKey",
  "bucket",
  "presignedUrl",
  "databaseUrl",
  "redisUrl",
  "NEXTAUTH_SECRET",
  "sha256",
];

function runProductionWorkerOnce(): Promise<{ code: number | null; stderr: string }> {
  // worker 需要 S3 凭据写 campus-private（与 playwright.config 的解析顺序
  // 一致；本地 compose MinIO root 默认 minioadmin）
  const s3Endpoint =
    process.env.E2E_S3_ENDPOINT ?? process.env.S3_ENDPOINT ?? "http://localhost:9100";

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
          S3_ENDPOINT: s3Endpoint,
          S3_ACCESS_KEY_ID: process.env.E2E_S3_ACCESS_KEY_ID ?? "minioadmin",
          S3_SECRET_ACCESS_KEY: process.env.E2E_S3_SECRET_ACCESS_KEY ?? "minioadmin",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("9C03-E2E-01：UI 点击 → 真实 worker 异步生成 → 本人授权下载 → 安全断言", async ({ browser }) => {
  test.setTimeout(240_000);

  const tag = uniqueTag("p9c03");
  const email = `${tag}@e2e.test`;
  const nickname = `异步导出${tag.slice(-8)}`;

  await flushRateLimits();

  // ---------- 注册 + 登录（真实 UI） ----------
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/register");
  await page.locator('input[name="name"]').first().fill(nickname);
  await page.locator('input[name="email"]').first().fill(email);
  await page.locator('input[name="password"]').first().fill("P03Pass#2026");
  await page.locator('input[name="confirmPassword"]').first().fill("P03Pass#2026");
  await page.locator('input[name="agreeLegal"]').first().check();
  await page.getByRole("button", { name: "注册账户" }).click();
  await expect(page.getByText("注册成功，请登录")).toBeVisible();
  await loginViaUI(page, email, "P03Pass#2026", nickname);

  const user = await e2eDb().user.findUniqueOrThrow({ where: { email } });
  const sellerUser = await e2eDb().user.findUniqueOrThrow({
    where: { email: E2E_ACCOUNTS.seller.email },
  });

  // ---------- fixture：订单（导出应含）+ 卖家私密手机号（绝不能含） ----------
  // FIX05：seller 是全套 E2E 共享 fixture——覆盖 phone 属临时变更，必须
  // 在 finally 恢复原值（断言/worker/下载中途失败也必须恢复，fixture
  // teardown 正确性本身属于测试合同；恢复失败必须显式可见，绝不静默吞掉）。
  const originalSellerPhone = sellerUser.phone;
  const sellerPhone = `137${String(Date.now()).slice(-8)}`;
  await e2eDb().user.update({ where: { id: sellerUser.id }, data: { phone: sellerPhone } });
  const orderNo = `P03-${tag}`;
  const order = await e2eDb().order.create({
    data: {
      orderNo,
      type: "PRODUCT",
      status: "COMPLETED",
      amount: "7.77",
      buyerId: user.id,
      sellerId: sellerUser.id,
    },
  });

  try {
    // ---------- UI 点击：POST 202，HTTP 不执行数据构建 ----------
    const legacyGet = await page.request.get("/api/privacy/export");
    expect(legacyGet.status()).toBe(405);

    await page.goto("/my/privacy");
    await page.getByTestId("export-data-trigger").first().click();
    await expect(
      page.getByTestId("export-status").first(),
    ).toHaveText(/正在排队|正在生成/, { timeout: 15_000 });

    const requests = await e2eDb().privacyRequest.findMany({
      where: { userId: user.id, type: "DATA_EXPORT" },
    });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.status).toBe("REQUESTED");

    const jobs = await e2eDb().asyncJob.findMany({
      where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ requestId: request.id });

    // ---------- RB06：production worker 协议互斥锁内有界驱动 ----------
    console.log(`[rb06-diag][9C03][lock] acquire-at=${new Date().toISOString()}`);
    let artifact!: { bucket: string; objectKey: string };
    await withE2EAsyncWorkerProtocolLock("phase9c03-async-export", async () => {
      // Step A（prepare → RESCHEDULE）+ Step B（generate → COMPLETED）
      // 常态两轮；有界 8 轮防共享队列挤占（每轮真实工作，零 sleep 猜测）
      for (let round = 0; round < 8; round += 1) {
        const current = await e2eDb().privacyRequest.findUniqueOrThrow({
          where: { id: request.id },
        });
        if (current.status === "COMPLETED") {
          break;
        }
        await e2eDb().asyncJob.update({
          where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
          data: { runAt: new Date() },
        });
        const { code, stderr } = await runProductionWorkerOnce();
        if (code !== 0) {
          throw new Error(`async-worker run-once failed: code=${code} stderr=${stderr.slice(0, 400)}`);
        }
      }

      const finalRequest = await e2eDb().privacyRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(finalRequest.status).toBe("COMPLETED");
      expect(finalRequest.completedAt).toBeTruthy();

      const finalJob = await e2eDb().asyncJob.findUniqueOrThrow({
        where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
      });
      expect(finalJob.status).toBe("COMPLETED");

      const artifactRow = await e2eDb().dataExportArtifact.findUniqueOrThrow({
        where: { requestId: request.id },
      });
      expect(artifactRow.status).toBe("READY");
      expect(artifactRow.sizeBytes).toBeGreaterThan(0);
      expect(artifactRow.sha256).toBeTruthy();
      expect(artifactRow.expiresAt!.getTime()).toBeGreaterThan(Date.now());
      artifact = { bucket: artifactRow.bucket, objectKey: artifactRow.objectKey };
    });

    // ---------- UI：完成后自动显示下载链接 + 有效期 ----------
    await expect(page.getByTestId("export-download-link").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("export-expiry").first()).toContainText("下载有效期至");

    // ---------- list 面：零内部定位符 ----------
    const listResponse = await page.request.get("/api/privacy/requests");
    expect(listResponse.status()).toBe(200);
    const listText = await listResponse.text();
    for (const forbidden of FORBIDDEN_INTERNAL_KEYS) {
      expect(listText.includes(forbidden)).toBe(false);
    }
    const listData = JSON.parse(listText);
    const exportDto = listData.requests.find(
      (entry: { id: string }) => entry.id === request.id,
    );
    expect(exportDto).toMatchObject({
      status: "COMPLETED",
      downloadAvailable: true,
      downloadPath: `/api/privacy/export/${request.id}/download`,
    });

    // ---------- 下载（真实 UI 点击）+ 内容安全断言 ----------
    const downloadPromise = page.waitForEvent("download", { timeout: 20_000 });
    await page.getByTestId("export-download-link").first().click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`campus-data-export-${request.id}.json`);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString("utf-8");
    const payload = JSON.parse(body);

    // 本人数据在（account.id == 当前用户；订单参与记录在）
    expect(payload.format).toBe("campus-marketplace.user-export/v3");
    expect(payload.account.id).toBe(user.id);
    expect(payload.orders.some((entry: { orderNo: string }) => entry.orderNo === orderNo)).toBe(
      true,
    );

    // 他人私密字段不在（卖家 email/手机号绝不出现）
    expect(body).not.toContain(E2E_ACCOUNTS.seller.email);
    expect(body).not.toContain(sellerPhone);

    // 内部秘密/存储内部形态不在（对象 key 含 userId+requestId，绝不泄漏）
    for (const forbidden of FORBIDDEN_INTERNAL_KEYS) {
      expect(body.includes(forbidden)).toBe(false);
    }
    expect(body).not.toContain(artifact.objectKey);
    expect(body).not.toContain(artifact.bucket);

    // ---------- 直接 API 下载：同形 + 安全响应头 ----------
    const apiDownload = await page.request.get(
      `/api/privacy/export/${request.id}/download`,
    );
    expect(apiDownload.status()).toBe(200);
    expect(apiDownload.headers()["content-type"]).toContain("application/json");
    expect(apiDownload.headers()["content-disposition"]).toContain("attachment");
    expect(apiDownload.headers()["cache-control"]).toContain("no-store");
    expect(apiDownload.headers()["x-content-type-options"]).toBe("nosniff");

    // ---------- 跨用户 anti-oracle：seller 会话请求同一下载 → 与不存在同形 ----------
    const sellerContext = await browser.newContext({
      storageState: storageStatePath("seller"),
    });
    const sellerPage = await sellerContext.newPage();
    const crossUser = await sellerPage.request.get(
      `/api/privacy/export/${request.id}/download`,
    );
    const notFound = await sellerPage.request.get(
      `/api/privacy/export/does-not-exist-request/download`,
    );
    expect(crossUser.status()).toBe(404);
    expect(notFound.status()).toBe(404);
    expect(await crossUser.text()).toBe(await notFound.text());
    await sellerContext.close();
  } finally {
    // fixture 恢复（独立于断言失败）：先恢复共享 seller 原值，再删订单；
    // context 关闭放最内层 finally，恢复失败不被吞掉——直接向上抛
    try {
      await e2eDb().user.update({
        where: { id: sellerUser.id },
        data: { phone: originalSellerPhone },
      });
      await e2eDb().order.delete({ where: { id: order.id } });
    } catch (cleanupError) {
      throw new Error(
        `9C03 E2E fixture 恢复失败（共享 seller fixture 可能被污染，需人工核查 seller.phone / 残留订单 ${orderNo}）：${String(cleanupError)}`,
      );
    } finally {
      await context.close();
    }
  }
});
