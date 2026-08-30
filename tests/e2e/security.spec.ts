import { test, expect } from "@playwright/test";
import { storageStatePath, uniqueTag } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";

/**
 * Security E2E — 权限回归 Release Gate（不依赖 unit test，真实浏览器验证）
 * 1. 普通用户不能打开 admin 页面
 * 2. 用户 B 不能编辑用户 A 的商品（404）
 * 3. 并发重复下单只能产生一个有效订单（乐观锁回归）
 */

test("权限回归：普通学生访问管理后台被重定向", async ({ browser }) => {
  const buyerContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const buyer = await buyerContext.newPage();

  await buyer.goto("/admin");
  // requireAdmin 对非管理员 redirect("/")——页面内容不可见
  await buyer.waitForURL((url) => url.pathname === "/");
  await expect(buyer.getByRole("heading", { name: "系统管理" })).toHaveCount(0);

  await buyer.goto("/admin/reports");
  await buyer.waitForURL((url) => url.pathname === "/");
  await expect(buyer.getByRole("heading", { name: "举报处理" })).toHaveCount(0);

  await buyerContext.close();
});

test("权限回归：其他用户打开商品编辑页得到 404", async ({ browser }) => {
  const tag = uniqueTag("sec-edit");

  // 卖家发布商品
  const sellerContext = await browser.newContext({ storageState: storageStatePath("seller") });
  const seller = await sellerContext.newPage();
  await seller.goto("/products/new");
  await seller.locator('input[name="title"]').first().fill(`E2E越权商品 ${tag}`);
  await seller.locator('select[name="categoryId"]').first().selectOption({ label: "其他闲置" });
  await seller.locator('input[name="price"]').first().fill("9.9");
  await seller.locator('input[name="locationText"]').first().fill("E2E 权限测试点");
  await seller.locator('textarea[name="description"]').first().fill(`E2E 越权编辑测试 ${tag}`);
  await seller.getByRole("button", { name: "确认发布商品" }).first().click();
  await seller.waitForURL(/\/products\/(?!new)[^/]+$/, { timeout: 30_000 });
  const productId = new URL(seller.url()).pathname.split("/").pop() ?? "";
  await sellerContext.close();

  // 买家（非卖家）打开编辑页：getProductForEdit 按 sellerId 过滤 → notFound。
  // Next.js streaming 下 404 页可能以 200 状态交付，以用户可见的 404 页面为准。
  const buyerContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const buyer = await buyerContext.newPage();
  await buyer.goto(`/products/${productId}/edit`);
  await expect(buyer.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await expect(buyer.getByRole("button", { name: "保存修改" })).toHaveCount(0);
  await buyerContext.close();
});

test("并发回归：两个会话同时下单同一商品只生成一个有效订单", async ({ browser }) => {
  const tag = uniqueTag("sec-dup");

  // 卖家发布商品
  const sellerContext = await browser.newContext({ storageState: storageStatePath("seller") });
  const seller = await sellerContext.newPage();
  await seller.goto("/products/new");
  await seller.locator('input[name="title"]').first().fill(`E2E并发商品 ${tag}`);
  await seller.locator('select[name="categoryId"]').first().selectOption({ label: "交通工具" });
  await seller.locator('input[name="price"]').first().fill("199");
  await seller.locator('input[name="locationText"]').first().fill("E2E 北门");
  await seller.locator('textarea[name="description"]').first().fill(`E2E 并发下单测试 ${tag}`);
  await seller.getByRole("button", { name: "确认发布商品" }).first().click();
  await seller.waitForURL(/\/products\/(?!new)[^/]+$/, { timeout: 30_000 });
  const productId = new URL(seller.url()).pathname.split("/").pop() ?? "";
  await sellerContext.close();

  // 同一买家两个会话并行提交购买
  const prepare = async () => {
    const context = await browser.newContext({ storageState: storageStatePath("buyer") });
    const page = await context.newPage();
    await page.goto(`/products/${productId}`);
    await page.getByRole("button", { name: "立即购买" }).first().click();
    await page.locator('input[name="meetingLocation"]').fill("E2E 并发面交点");
    return { context, page };
  };

  const [sessionA, sessionB] = await Promise.all([prepare(), prepare()]);
  await Promise.all([
    sessionA.page.getByRole("button", { name: "确认提交订单" }).click(),
    sessionB.page.getByRole("button", { name: "确认提交订单" }).click(),
  ]);

  // 至少一个会话完成下单跳转；另一个看到“已有进行中的订单”或同样跳转
  await Promise.race([
    sessionA.page.waitForURL(/\/my\/orders/, { timeout: 20_000 }),
    sessionB.page.waitForURL(/\/my\/orders/, { timeout: 20_000 }),
  ]);

  // DB 不变量：有效订单数 = 1（RESERVED 乐观锁保证）
  await expect
    .poll(async () => {
      const orders = await e2eDb().order.findMany({
        where: { productId, status: { in: ["PENDING", "ACCEPTED", "IN_PROGRESS", "COMPLETED"] } },
      });
      return orders.length;
    })
    .toBe(1);

  const product = await e2eDb().product.findUnique({ where: { id: productId } });
  expect(product?.status).toBe("RESERVED");

  await sessionA.context.close();
  await sessionB.context.close();
});
