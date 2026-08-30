import { test, expect } from "@playwright/test";
import { storageStatePath, uniqueTag } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";

/**
 * GOLDEN FLOW 4 — 跑腿：发布 → 接单 → 开始 → 提交完成 → 发布者确认完成
 * 负例：发布者本人看不到接单人专属操作
 */

function localDateTime(offsetHours: number): string {
  const date = new Date(Date.now() + offsetHours * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test("跑腿：发布 → 接单 → 开始任务 → 提交完成 → 发布者确认完成", async ({ browser }) => {
  const tag = uniqueTag("gf4");
  const title = `E2E跑腿 ${tag}`;

  // ---------- 发布者（buyer 账号）发布任务 ----------
  const publisherContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const publisher = await publisherContext.newPage();
  await publisher.goto("/errands/new");
  await publisher.locator('input[name="title"]').first().fill(title);
  await publisher.locator('textarea[name="description"]').first().fill(`E2E 跑腿任务描述 ${tag}`);
  await publisher.locator('select[name="categoryId"]').first().selectOption({ label: "代取快递" });
  await publisher.locator('input[name="reward"]').first().fill("8.8");
  await publisher.locator('input[name="pickupLocation"]').first().fill("E2E 东区快递站");
  await publisher.locator('input[name="deliveryLocation"]').first().fill("E2E 3号楼 402");
  await publisher.locator('input[name="deadline"]').first().fill(localDateTime(3));
  await publisher.getByRole("button", { name: "发布任务" }).first().click();
  // Next.js 软导航：等详情页标题（level=1 为详情页，避免匹配 /errands/new）
  await expect(publisher.getByRole("heading", { level: 1, name: title })).toBeVisible({
    timeout: 30_000,
  });
  await publisher.waitForURL(/\/errands\/(?!new)[^/]+$/, { waitUntil: "commit" });
  const errandPath = new URL(publisher.url()).pathname;
  const errandId = errandPath.split("/").pop() ?? "";

  // 发布者自己不应看到「立即接单」（接单者专属操作）
  await expect(publisher.getByRole("button", { name: "立即接单" })).toHaveCount(0);

  const errand = await e2eDb().errandTask.findUnique({ where: { id: errandId } });
  expect(errand?.status).toBe("OPEN");

  // ---------- 接单者（seller 账号）浏览并接单 ----------
  const accepterContext = await browser.newContext({ storageState: storageStatePath("seller") });
  const accepter = await accepterContext.newPage();
  await accepter.goto("/errands");
  await accepter.locator('input[name="q"]').first().fill(tag);
  await accepter.keyboard.press("Enter");
  await accepter.getByRole("link", { name: new RegExp(title) }).first().click();
  await accepter.waitForURL(/\/errands\/[^/]+$/);

  await accepter.getByRole("button", { name: "立即接单" }).first().click();
  await accepter.getByRole("button", { name: "确认接单" }).first().click();
  await expect(accepter.getByText("接单成功").first()).toBeVisible();
  await accepter.waitForURL(/\/my\/orders/, { timeout: 20_000 });

  await expect
    .poll(async () => (await e2eDb().errandTask.findUnique({ where: { id: errandId } }))?.status)
    .toBe("CLAIMED");

  // ---------- 接单者开始任务 ----------
  await accepter.goto(`/errands/${errandId}`);
  await accepter.getByRole("button", { name: "开始任务" }).first().click();
  await expect
    .poll(async () => (await e2eDb().errandTask.findUnique({ where: { id: errandId } }))?.status)
    .toBe("IN_PROGRESS");

  // ---------- 负例（premature completion gate）：接单者仅"开始任务"后， ----------
  // 发布者订单中心不得出现"确认完成"入口；服务端同样拒绝提前完成
  await publisher.goto("/my/orders?type=errand");
  const prematureCard = publisher.locator("article", { hasText: title }).first();
  await expect(prematureCard).toBeVisible();
  // 此时 Order = IN_PROGRESS，但 ErrandTask 未到 PENDING_CONFIRMATION
  await expect(prematureCard.getByRole("button", { name: "确认完成" })).toHaveCount(0);
  await expect(prematureCard.getByText("接单者履约中").first()).toBeVisible();

  const prematureTask = await e2eDb().errandTask.findUnique({ where: { id: errandId } });
  const prematureOrder = await e2eDb().order.findFirst({ where: { errandTaskId: errandId } });
  expect(prematureTask?.status).toBe("IN_PROGRESS");
  expect(prematureOrder?.status).toBe("IN_PROGRESS");

  // ---------- 接单者提交完成 ----------
  await accepter.goto(`/errands/${errandId}`);
  await accepter.getByRole("button", { name: "提交完成" }).first().click();
  await expect
    .poll(async () => (await e2eDb().errandTask.findUnique({ where: { id: errandId } }))?.status)
    .toBe("PENDING_CONFIRMATION");

  // ---------- 发布者确认完成（订单中心确认弹窗）：提交完成后入口才出现 ----------
  await publisher.goto("/my/orders?type=errand");
  const publisherCard = publisher.locator("article", { hasText: title }).first();
  await expect(publisherCard).toBeVisible();
  await expect(publisherCard.getByRole("button", { name: "确认完成" })).toBeVisible();
  await publisherCard.getByRole("button", { name: "确认完成" }).click();
  await publisher.getByRole("button", { name: "确认收货/完成" }).click();
  await expect(
    publisher.locator("article", { hasText: title }).first().getByText("跑腿已完成").first(),
  ).toBeVisible({ timeout: 20_000 });

  await expect
    .poll(async () => (await e2eDb().errandTask.findUnique({ where: { id: errandId } }))?.status)
    .toBe("COMPLETED");

  // Order 与 ErrandTask 状态机收敛一致
  const finalOrder = await e2eDb().order.findFirst({ where: { errandTaskId: errandId } });
  expect(finalOrder?.status).toBe("COMPLETED");

  // 双方订单页状态一致
  await accepter.goto("/my/orders?type=errand");
  await expect(
    accepter.locator("article", { hasText: title }).first().getByText("跑腿已完成").first(),
  ).toBeVisible();

  await publisherContext.close();
  await accepterContext.close();
});
