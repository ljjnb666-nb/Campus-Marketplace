import { test, expect } from "@playwright/test";
import { storageStatePath, uniqueTag, FIXTURE_IMAGES } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";

/**
 * GOLDEN FLOW 2 — 二手商品：卖家发布（真实 MinIO 图片上传）→ 买家搜索 → 详情 → 收藏 → 下单
 * 链路：Browser → Next.js → Server Action → PostgreSQL / MinIO，全程无 mock。
 */

test("商品发布到下单：卖家上传图片发布 → 买家搜索 → 收藏持久化 → 创建订单", async ({ browser }) => {
  const tag = uniqueTag("gf2");
  const title = `E2E商品 ${tag}`;

  // ---------- 卖家：发布商品（含真实图片上传） ----------
  const sellerContext = await browser.newContext({ storageState: storageStatePath("seller") });
  const seller = await sellerContext.newPage();

  await seller.goto("/products/new");
  await seller.locator('input[name="title"]').first().fill(title);
  await seller.locator('select[name="categoryId"]').first().selectOption({ label: "教材资料" });
  await seller.locator('input[name="price"]').first().fill("66.6");
  await seller.locator('input[name="locationText"]').first().fill("E2E 图书馆门口");
  await seller.locator('textarea[name="description"]').first().fill(`E2E 测试商品描述 ${tag}`);

  // ImageUploader：选图后立即经 /api/upload/images 上传到 MinIO public bucket
  // （页面双渲染，file input 同样存在两份）
  await seller.locator('form input[type="file"]').first().setInputFiles(FIXTURE_IMAGES.product);
  await expect(seller.getByAltText("预览 1").first()).toBeVisible({ timeout: 20_000 });

  await seller.getByRole("button", { name: "确认发布商品" }).first().click();
  await seller.waitForURL(/\/products\/(?!new)[^/]+$/, { timeout: 30_000 });
  const productPath = new URL(seller.url()).pathname;
  const productId = productPath.split("/").pop() ?? "";

  // 详情页正常渲染标题与 MinIO 公开图片
  await expect(seller.getByRole("heading", { name: title })).toBeVisible();
  const coverImage = seller.locator(`img[src*="campus-public"]`).first();
  await expect(coverImage).toBeVisible();

  // DB 验证：商品 ACTIVE 且图片行指向 MinIO 公开 bucket
  const product = await e2eDb().product.findUnique({
    where: { id: productId },
    include: { images: true },
  });
  expect(product?.status).toBe("ACTIVE");
  expect(product?.images.length).toBeGreaterThan(0);
  expect(product?.images[0].url).toContain("campus-public");

  // 真实验证：对象在 MinIO 中可取回（HTTP GET 公开对象，非内部函数）
  const imageResponse = await seller.request.get(product?.images[0].url ?? "");
  expect(imageResponse.status()).toBe(200);
  expect((await imageResponse.headers())["content-type"] ?? "").toContain("image/");
  await sellerContext.close();

  // ---------- 买家：搜索 → 详情 → 收藏 ----------
  const buyerContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const buyer = await buyerContext.newPage();

  await buyer.goto("/products");
  await buyer.locator('input[name="q"]').fill(tag);
  await buyer.keyboard.press("Enter");
  await buyer.getByRole("link", { name: new RegExp(title) }).first().click();
  await buyer.waitForURL(/\/products\/[^/]+$/);
  await expect(buyer.getByRole("heading", { name: title })).toBeVisible();

  // 收藏 → 状态持久化（刷新后仍是已收藏）
  await buyer.getByRole("button", { name: /收藏/ }).first().click();
  await expect(buyer.getByRole("button", { name: /已收藏/ })).toBeVisible();
  await buyer.reload();
  await expect(buyer.getByRole("button", { name: /已收藏/ })).toBeVisible();

  const buyerUser = await e2eDb().user.findUnique({ where: { email: "e2e-buyer@e2e.test" } });
  const favorite = await e2eDb().favorite.findFirst({
    where: { userId: buyerUser?.id, productId },
  });
  expect(favorite).not.toBeNull();

  // ---------- 买家：创建订单 ----------
  await buyer.getByRole("button", { name: "立即购买" }).first().click();
  await buyer.locator('input[name="meetingLocation"]').fill("E2E 一食堂侧门");
  await buyer.getByRole("button", { name: "确认提交订单" }).click();
  await buyer.waitForURL(/\/my\/orders/, { timeout: 20_000 });

  const order = await e2eDb().order.findFirst({
    where: { productId, buyerId: buyerUser?.id },
  });
  expect(order?.status).toBe("PENDING");
  expect(order?.type).toBe("PRODUCT");

  // 下单后商品进入 RESERVED，不可被再次购买
  const reservedProduct = await e2eDb().product.findUnique({ where: { id: productId } });
  expect(reservedProduct?.status).toBe("RESERVED");

  await buyerContext.close();
});
