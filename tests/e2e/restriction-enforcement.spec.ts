import { test, expect } from "@playwright/test";
import { storageStatePath, uniqueTag, FIXTURE_IMAGES } from "./helpers/e2e";
import { e2eDb, seedActiveRestriction } from "./helpers/db";

/**
 * GOLDEN FLOW — Phase 6B marketplace 能力门：
 * 受限用户（GLOBAL RESTRICTED）不能开始新的交易活动（商品发布被拒），
 * 普通用户路径不受影响；管理后台对受限用户依旧不可入（无客户端判权）。
 * 执法 service 的真实 PG 并发矩阵见 tests/integration/phase6b-trust-enforcement.test.ts。
 */

test("受限用户不能开始新交易活动；普通用户不受影响", async ({ browser }) => {
  const tag = uniqueTag("gf-restrict");

  // ---------- fixture：给专用受限账号打上 GLOBAL RESTRICTED（仅 E2E 基建 seam；
  // 使用独立账号避免与并行 worker 中其他使用 buyer 的 spec 串扰） ----------
  const restrictedEmail = "e2e-restricted@e2e.test";
  await seedActiveRestriction(restrictedEmail);

  // ---------- 受限用户发布商品 → 能力门拒绝 ----------
  const restrictedContext = await browser.newContext({ storageState: storageStatePath("restricted") });
  const restricted = await restrictedContext.newPage();
  await restricted.goto("/products/new");
  await restricted.locator('input[name="title"]').first().fill(`受限商品 ${tag}`);
  await restricted.locator('select[name="categoryId"]').first().selectOption({ label: "生活用品" });
  await restricted.locator('input[name="price"]').first().fill("9.9");
  await restricted.locator('input[name="locationText"]').first().fill("E2E 限制测试");
  await restricted
    .locator('textarea[name="description"]')
    .first()
    .fill(`E2E restricted ${tag}`);
  await restricted.getByRole("button", { name: "确认发布商品" }).first().click();

  await expect(restricted.getByText("当前无法开始新的交易活动")).toBeVisible({
    timeout: 15_000,
  });

  // 数据库零写入：受限发布不产生任何商品行
  const count = await e2eDb().product.count({
    where: { title: `受限商品 ${tag}` },
  });
  expect(count).toBe(0);
  await restrictedContext.close();

  // ---------- 受限用户的既有浏览能力不受影响（软限制不踢出系统） ----------
  const browseContext = await browser.newContext({ storageState: storageStatePath("restricted") });
  const browse = await browseContext.newPage();
  await browse.goto("/products");
  await expect(browse.locator("body")).toContainText("校园集市");
  await browseContext.close();

  // ---------- 管理后台对受限用户依旧不可入（无客户端判权） ----------
  const adminProbeContext = await browser.newContext({ storageState: storageStatePath("restricted") });
  const adminProbe = await adminProbeContext.newPage();
  await adminProbe.goto("/admin");
  await expect(adminProbe).toHaveURL(/^(?!.*\/admin).*$/);
  await adminProbeContext.close();

  // ---------- 普通卖家正常发布（能力门不误伤未受限用户） ----------
  const sellerContext = await browser.newContext({ storageState: storageStatePath("seller") });
  const seller = await sellerContext.newPage();
  await seller.goto("/products/new");
  await seller.locator('input[name="title"]').first().fill(`正常商品 ${tag}`);
  await seller.locator('select[name="categoryId"]').first().selectOption({ label: "其他闲置" });
  await seller.locator('input[name="price"]').first().fill("15");
  await seller.locator('input[name="locationText"]').first().fill("E2E 正常路径");
  await seller.locator('textarea[name="description"]').first().fill(`E2E normal ${tag}`);
  await seller
    .locator('input[type="file"]')
    .first()
    .setInputFiles(FIXTURE_IMAGES.product);
  await seller.getByRole("button", { name: "确认发布商品" }).first().click();
  await seller.waitForURL(/\/products\/(?!new)[^/]+$/, { timeout: 30_000 });

  const normal = await e2eDb().product.findFirst({
    where: { title: `正常商品 ${tag}` },
    select: { id: true, status: true },
  });
  expect(normal?.status).toBe("ACTIVE");
  await sellerContext.close();
});
