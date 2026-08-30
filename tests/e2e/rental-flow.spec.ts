import { test, expect } from "@playwright/test";
import { storageStatePath, uniqueTag, FIXTURE_IMAGES } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";

/**
 * GOLDEN FLOW 6 — 租赁完整链路（高风险业务 Release Gate）
 * 发布 → 申请 → 批准 → 双方交接（真实 private MinIO 照片）→ 租赁中
 * → 归还申请 → 归还验收 → 完成
 * 附带 private asset HTTP 边界：上传者/参与双方/ADMIN 可访问，
 * 无关用户 403、匿名 401（走真实 /api/assets/{id}/access）
 */

function localDateTime(offsetHours: number): string {
  const date = new Date(Date.now() + offsetHours * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test("租赁：发布 → 申请 → 批准 → 双方交接 → 归还 → 验收完成 + 私有资产权限边界", async ({ browser }) => {
  const tag = uniqueTag("gf6");
  const title = `E2E租赁 ${tag}`;

  // ---------- OWNER（seller）发布租赁物品 ----------
  const ownerContext = await browser.newContext({ storageState: storageStatePath("seller") });
  const owner = await ownerContext.newPage();
  await owner.goto("/rentals/new");
  await owner.locator('input[name="title"]').first().fill(title);
  await owner.locator('select[name="categoryId"]').first().selectOption({ label: "相机 / 摄影器材" });
  await owner.locator('select[name="condition"]').first().selectOption({ label: "99新" });
  await owner.locator('input[name="price"]').first().fill("50");
  await owner.locator('input[name="depositAmount"]').first().fill("0");
  await owner.locator('input[name="minimumDuration"]').first().fill("1");
  await owner.locator('input[name="maximumDuration"]').first().fill("24");
  await owner.locator('input[name="pickupLocation"]').first().fill("E2E 快递驿站");
  await owner.locator('input[name="returnLocation"]').first().fill("E2E 快递驿站");
  await owner.locator('textarea[name="description"]').first().fill(`E2E 租赁物品描述 ${tag}`);
  // requiresApproval 默认勾选：申请需要出租者确认
  await owner.getByRole("button", { name: "发布租赁" }).click();
  // 发布成功后跳转 /my/rental-listings（管理页）；从那里确认新 listing 可见，
  // 并读取详情链接供后续订单流程使用
  await expect(owner.getByRole("heading", { level: 1, name: "出租物品管理" })).toBeVisible({
    timeout: 30_000,
  });
  const listingLink = owner.locator('a[href^="/rentals/"]', { hasText: title }).first();
  await expect(listingLink).toBeVisible({ timeout: 15_000 });
  const rentalListingHref = await listingLink.getAttribute("href");
  const rentalListingId = rentalListingHref?.split("/").pop() ?? "";

  // DB 不变量：listing 已创建且可租
  await expect
    .poll(async () => (await e2eDb().rentalListing.findUnique({ where: { id: rentalListingId } }))?.status)
    .toBe("AVAILABLE");

  // ---------- RENTER（buyer）申请租赁 ----------
  const renterContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const renter = await renterContext.newPage();
  await renter.goto("/rentals");
  await renter.locator('input[name="q"]').first().fill(tag);
  await renter.keyboard.press("Enter");
  await renter.getByRole("link", { name: new RegExp(title) }).first().click();
  await expect(renter.getByRole("heading", { level: 1, name: title })).toBeVisible({ timeout: 20_000 });

  await renter.getByRole("button", { name: "立即租用" }).first().click();
  // 等预约抽屉真正打开再填时间（规避打开动画竞态）
  await expect(renter.getByRole("heading", { name: "确认提交物品租赁订单" })).toBeVisible({
    timeout: 15_000,
  });
  await renter.locator('input[name="startTime"]').fill(localDateTime(2));
  await renter.locator('input[name="endTime"]').fill(localDateTime(26));
  await renter.getByRole("button", { name: "提交租赁订单" }).click();
  // 抽屉先展示成功动画，随后 window.location.href 跳转订单详情
  await expect(renter.getByText("租赁订单创建成功！")).toBeVisible({ timeout: 15_000 });
  await renter.waitForURL(/\/rental-orders\/[^/]+$/, { timeout: 20_000 });
  const orderId = new URL(renter.url()).pathname.split("/").pop() ?? "";

  await expect
    .poll(async () => (await e2eDb().rentalOrder.findUnique({ where: { id: orderId } }))?.status)
    .toBe("PENDING_APPROVAL");

  // ---------- OWNER 批准 ----------
  await owner.goto(`/rental-orders/${orderId}`);
  await owner.getByRole("button", { name: "同意租用" }).click();
  await expect
    .poll(async () => (await e2eDb().rentalOrder.findUnique({ where: { id: orderId } }))?.status)
    .toBe("PENDING_PICKUP");

  // ---------- RENTER 确认取货（上传交接照片 → private MinIO） ----------
  // RentalActionForm 成功后无跳转反馈：以 DB 状态为准，再回详情页验证 UI
  await renter.goto(`/rental-orders/${orderId}`);
  await renter.getByRole("link", { name: "确认取货" }).click();
  await renter.waitForURL(/\/handover$/, { timeout: 15_000, waitUntil: "commit" });
  await renter.locator('input[name="photos"]').setInputFiles(FIXTURE_IMAGES.handover);
  await renter.getByRole("button", { name: "确认已交接" }).click();
  await expect
    .poll(
      async () =>
        (
          await e2eDb().rentalHandoverRecord.findUnique({ where: { orderId } })
        )?.renterConfirmed,
    )
    .toBe(true);
  await expect
    .poll(async () => (await e2eDb().uploadedAsset.count({ where: { category: "HANDOVER" } })))
    .toBeGreaterThanOrEqual(1);

  await renter.goto(`/rental-orders/${orderId}`);
  await expect(renter.getByText(/租客：已确认/).first()).toBeVisible();

  // ---------- OWNER 前往取货验收（双方确认后进入租赁中） ----------
  await owner.goto(`/rental-orders/${orderId}`);
  await owner.getByRole("link", { name: "前往取货验收" }).click();
  await owner.waitForURL(/\/handover$/, { timeout: 15_000, waitUntil: "commit" });
  await owner.locator('input[name="photos"]').setInputFiles(FIXTURE_IMAGES.handover);
  await owner.getByRole("button", { name: "确认已交接" }).click();
  await expect
    .poll(async () => (await e2eDb().rentalOrder.findUnique({ where: { id: orderId } }))?.status)
    .toBe("IN_RENTAL");

  // ---------- RENTER 归还申请 ----------
  await renter.goto(`/rental-orders/${orderId}`);
  await renter.getByRole("link", { name: "申请归还" }).click();
  await renter.waitForURL(/\/return$/, { timeout: 15_000, waitUntil: "commit" });
  await renter.getByRole("button", { name: "提交归还申请" }).click();
  await expect
    .poll(async () => (await e2eDb().rentalOrder.findUnique({ where: { id: orderId } }))?.status)
    .toBe("PENDING_RETURN");

  // ---------- OWNER 验收归还（上传归还照片，无损坏 → 完成） ----------
  await owner.goto(`/rental-orders/${orderId}`);
  await owner.getByRole("link", { name: "前往验收归还" }).click();
  await owner.waitForURL(/\/return$/, { timeout: 15_000, waitUntil: "commit" });
  await owner.locator('input[name="photos"]').setInputFiles(FIXTURE_IMAGES.return);
  await owner.getByRole("button", { name: "确认完好归还" }).click();
  await expect
    .poll(async () => (await e2eDb().rentalOrder.findUnique({ where: { id: orderId } }))?.status)
    .toBe("COMPLETED");

  // ---------- 私有资产权限边界（真实 HTTP，非内部函数） ----------
  const handoverAssets = await e2eDb().uploadedAsset.findMany({
    where: { category: "HANDOVER", status: "ATTACHED" },
  });
  expect(handoverAssets.length).toBeGreaterThanOrEqual(2);

  const assetId = handoverAssets[0].id;
  const accessUrl = `/api/assets/${assetId}/access`;

  // 参与双方（OWNER / RENTER）可获取签名 URL
  const ownerResponse = await owner.request.get(accessUrl);
  expect(ownerResponse.status()).toBe(200);
  const ownerBody = await ownerResponse.json();
  expect(ownerBody.access).toBe("PRIVATE");
  expect(ownerBody.url).toContain("campus-private");

  const renterResponse = await renter.request.get(accessUrl);
  expect(renterResponse.status()).toBe(200);

  // ADMIN 可访问
  const adminContext = await browser.newContext({ storageState: storageStatePath("admin") });
  const admin = await adminContext.newPage();
  const adminResponse = await admin.request.get(accessUrl);
  expect(adminResponse.status()).toBe(200);

  // 无关用户 403
  const outsiderContext = await browser.newContext({ storageState: storageStatePath("outsider") });
  const outsider = await outsiderContext.newPage();
  const outsiderResponse = await outsider.request.get(accessUrl);
  expect(outsiderResponse.status()).toBe(403);

  // 无关用户直接打开租赁订单详情 → notFound（streaming 下可能以 200 交付 404 页，
  // 以"拿不到订单数据"为准：详情页应由参与者才能看到租赁物品标题）
  const outsiderDetailBody = await (
    await outsider.request.get(`/rental-orders/${orderId}`)
  ).text();
  expect(outsiderDetailBody).not.toContain("租赁订单详情");

  // 匿名 401
  const anonContext = await browser.newContext();
  const anon = await anonContext.newPage();
  const anonResponse = await anon.request.get(accessUrl);
  expect(anonResponse.status()).toBe(401);

  await ownerContext.close();
  await renterContext.close();
  await adminContext.close();
  await outsiderContext.close();
  await anonContext.close();
});
