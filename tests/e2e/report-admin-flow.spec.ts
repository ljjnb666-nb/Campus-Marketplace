import { test, expect } from "@playwright/test";
import { storageStatePath, uniqueTag } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";

/**
 * GOLDEN FLOW 8 — 举报 → 管理员处理
 * 买家举报卖家商品 → 管理员后台看到 → 标记处理中 → 处理完成 → DB 状态 RESOLVED
 * 本应用举报表单不支持图片证据（REPORT 私有资产路径在租赁链路中验证，见 rental-flow.spec.ts）
 */

test("举报与 moderation：买家举报商品 → 管理员处理完成", async ({ browser }) => {
  const tag = uniqueTag("gf8");
  const title = `E2E举报商品 ${tag}`;

  // ---------- 卖家发布商品 ----------
  const sellerContext = await browser.newContext({ storageState: storageStatePath("seller") });
  const seller = await sellerContext.newPage();
  await seller.goto("/products/new");
  await seller.locator('input[name="title"]').first().fill(title);
  await seller.locator('select[name="categoryId"]').first().selectOption({ label: "生活用品" });
  await seller.locator('input[name="price"]').first().fill("19.9");
  await seller.locator('input[name="locationText"]').first().fill("E2E 宿舍楼下");
  await seller.locator('textarea[name="description"]').first().fill(`E2E 举报链路 ${tag}`);
  await seller.getByRole("button", { name: "确认发布商品" }).click();
  await seller.waitForURL(/\/products\/(?!new)[^/]+$/, { timeout: 30_000 });
  const productId = new URL(seller.url()).pathname.split("/").pop() ?? "";
  await sellerContext.close();

  // ---------- 买家发起举报（真实弹窗表单 → server action） ----------
  const buyerContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const buyer = await buyerContext.newPage();
  await buyer.goto(`/products/${productId}`);
  await buyer.getByRole("button", { name: "举报商品" }).click();
  await buyer.locator('select[name="reason"]').selectOption("FAKE_INFO");
  await buyer.locator('textarea[name="detail"]').fill(`E2E 举报详情 ${tag}`);
  await buyer.getByRole("button", { name: "提交举报" }).click();
  // 弹窗先展示成功动画再关闭
  await expect(buyer.getByText("举报已成功提交")).toBeVisible({ timeout: 15_000 });

  const report = await e2eDb().report.findFirst({
    where: { productId },
    orderBy: { createdAt: "desc" },
  });
  expect(report?.status).toBe("OPEN");
  expect(report?.reason).toBe("FAKE_INFO");
  await buyerContext.close();

  // ---------- 管理员后台处理 ----------
  const adminContext = await browser.newContext({ storageState: storageStatePath("admin") });
  const admin = await adminContext.newPage();
  await admin.goto("/admin/reports");
  const reportCard = admin.locator("article", { hasText: title }).first();
  await expect(reportCard).toBeVisible();

  // 标记处理中（form submit 走 server action，成功后页面可能整页刷新）
  await reportCard.getByRole("button", { name: "标记处理中" }).click();
  await expect
    .poll(
      async () =>
        (await e2eDb().report.findFirst({ where: { productId }, orderBy: { createdAt: "desc" } }))
          ?.status,
    )
    .toBe("IN_REVIEW");

  // 重新加载后台页后再填备注并完成处理，避免 action 刷新后 locator 指向旧 DOM
  await admin.goto("/admin/reports");
  const refreshedCard = admin.locator("article", { hasText: title }).first();
  await expect(refreshedCard).toBeVisible();
  await refreshedCard.getByPlaceholder("填写处理说明").first().fill(`E2E 处理备注 ${tag}`);
  await refreshedCard.getByRole("button", { name: "处理完成" }).click();
  await expect
    .poll(
      async () =>
        (await e2eDb().report.findFirst({ where: { productId }, orderBy: { createdAt: "desc" } }))
          ?.status,
    )
    .toBe("RESOLVED");

  // DB 终态：RESOLVED + 处理备注落库
  await expect
    .poll(async () => {
      const report = await e2eDb().report.findFirst({
        where: { productId },
        orderBy: { createdAt: "desc" },
      });
      return report?.handledNote ?? "";
    })
    .toContain(tag);

  await adminContext.close();
});
