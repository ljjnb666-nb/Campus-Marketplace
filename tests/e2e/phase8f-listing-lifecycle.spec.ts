import { test, expect } from "@playwright/test";
import { storageStatePath, uniqueTag } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";

/**
 * Phase 8F — Listing Lifecycle Normalization（真实浏览器 + 生产 UI）。
 *
 * 核心生命周期 transition 全部走 production UI/Server Action（不得直写
 * DB 状态替代核心 transition）；DB 只作最终不变量断言。
 *
 *  - E2E-01（§64）Product：发布 → 公开可见 → 下单 RESERVED → 公开消失 →
 *    卖家无法覆盖 RESERVED（无 mutation 按钮 + 删除被 active obligation
 *    拒绝且提示可见）→ 买家/卖家私有上下文保留（陌生第三方 404）→ 取消
 *    订单释放预留 → 公开重新可见
 *  - E2E-02（§65）Service：发布 → 公开可见 → 暂停接单 → 公开列表/详情隐藏、
 *    owner 管理可见 → 恢复 → 公开可见
 *  - E2E-03（§66）Rental：发布 → 公开可见 → 暂停出租 → 公开隐藏、owner 可见
 *    → 恢复 → 租客下单 → owner 删除 DENY（确认框 + 中文错误可见）
 *  - E2E-04（§67）Errand：发布 OPEN 公开可见 → 接单 CLAIMED → 公开消失 →
 *    publisher/accepter 详情保留（wind-down 横幅）→ 陌生第三方 404
 *  - E2E-05（§68/§69）Mobile 390x844：owner lifecycle 面 status action 可用、
 *    删除确认可用、无横向溢出、无 raw enum
 */

/** 为 window.confirm（DeleteListingForm / 删除确认）注册自动接受。 */
function acceptDialogs(page: import("@playwright/test").Page): void {
  page.on("dialog", (dialog) => {
    void dialog.accept();
  });
}

/**
 * 全量套件并行 worker 下共享 production server 偶发 ERR_ABORTED：
 * goto 失败时指数退避重试（负载型瞬断，非应用错误）。
 */
async function safeGoto(page: import("@playwright/test").Page, path: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(path);
      return;
    } catch (error) {
      if (attempt >= 4 || !String(error).includes("ERR_ABORTED")) {
        throw error;
      }
      await page.waitForTimeout(500 * attempt);
    }
  }
}

/** my/rental-listings 中指定 listing 的行容器（最近 rounded-3xl 祖先）。 */
function rentalRow(page: import("@playwright/test").Page, rentalListingId: string) {
  return page
    .locator(`a[href="/rentals/${rentalListingId}"]`)
    .locator('xpath=ancestor::div[contains(@class,"rounded-3xl")][1]');
}

test("8F-E2E-01 商品生命周期：RESERVED 系统权威 + 公开曝光收敛 + 取消释放", async ({ browser }) => {
  const tag = uniqueTag("p8f1");
  const title = `E2E8F商品 ${tag}`;

  // ---------- 卖家：发布 ACTIVE 商品 ----------
  const sellerContext = await browser.newContext({ storageState: storageStatePath("seller") });
  acceptDialogs(sellerContext.pages()[0] ?? (await sellerContext.newPage()));
  const seller = await sellerContext.newPage();
  acceptDialogs(seller);
  await safeGoto(seller, "/products/new");
  await seller.locator('input[name="title"]').first().fill(title);
  await seller.locator('select[name="categoryId"]').first().selectOption({ label: "教材资料" });
  await seller.locator('input[name="price"]').first().fill("66.6");
  await seller.locator('input[name="locationText"]').first().fill("E2E 图书馆门口");
  await seller.locator('textarea[name="description"]').first().fill(`E2E 8F 商品描述 ${tag}`);
  await seller.getByRole("button", { name: "确认发布商品" }).first().click();
  await seller.waitForURL(/\/products\/(?!new)[^/]+$/, { timeout: 30_000 });
  const productId = new URL(seller.url()).pathname.split("/").pop() ?? "";
  await expect
    .poll(async () => (await e2eDb().product.findUnique({ where: { id: productId } }))?.status)
    .toBe("ACTIVE");

  // ---------- 买家：公开列表可见 → 下单 → RESERVED ----------
  const buyerContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const buyer = await buyerContext.newPage();
  acceptDialogs(buyer);
  await safeGoto(buyer, "/products");
  await buyer.locator('input[name="q"]').first().fill(tag);
  await buyer.keyboard.press("Enter");
  await buyer.getByRole("link", { name: new RegExp(title) }).first().click();
  await buyer.waitForURL(/\/products\/[^/]+$/);
  await buyer.getByRole("button", { name: "立即购买" }).first().click();
  await buyer.locator('input[name="meetingLocation"]').fill("E2E 图书馆大厅");
  await buyer.getByRole("button", { name: "确认提交订单" }).click();
  await buyer.waitForURL(/\/my\/orders/, { timeout: 20_000 });
  await expect
    .poll(async () => (await e2eDb().product.findUnique({ where: { id: productId } }))?.status)
    .toBe("RESERVED");

  // ---------- 公开曝光收敛：列表不再出现；陌生第三方详情 404 ----------
  await safeGoto(buyer, "/products");
  await buyer.locator('input[name="q"]').first().fill(tag);
  await buyer.keyboard.press("Enter");
  await expect(buyer.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);

  const outsiderContext = await browser.newContext();
  const outsider = await outsiderContext.newPage();
  await safeGoto(outsider, `/products/${productId}`);
  await expect(outsider.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await outsiderContext.close();

  // ---------- 卖家：RESERVED 不可覆盖（无 mutation 按钮）+ 删除被拒 ----------
  await safeGoto(seller, "/my/products");
  const sellerCard = seller.locator("article", { hasText: title }).first();
  await expect(sellerCard.getByText("已预订")).toBeVisible();
  // Phase 8F（§42）：RESERVED 不渲染必然失败的 mutation 按钮
  await expect(sellerCard.getByRole("button", { name: "重新上架" })).toHaveCount(0);
  await expect(sellerCard.getByRole("button", { name: "下架" })).toHaveCount(0);
  // Phase 8F（§70）：active obligation 删除 DENY 且提示可见（不再是 silent no-op）
  await sellerCard.getByRole("button", { name: "删除" }).click();
  await expect(sellerCard.getByText(/进行中的交易/).first()).toBeVisible({ timeout: 15_000 });
  expect(
    (await e2eDb().product.findUnique({ where: { id: productId } }))?.deletedAt,
  ).toBeNull();

  // ---------- 参与方/owner 私有上下文保留（§16/§17）+ wind-down 提示 ----------
  await safeGoto(buyer, `/products/${productId}`);
  await expect(buyer.getByRole("heading", { name: title })).toBeVisible();
  await expect(buyer.getByText("该商品已进入预订流程，交易进行中").first()).toBeVisible();
  await expect(buyer.getByRole("button", { name: "立即购买" })).toHaveCount(0);
  await expect(buyer.getByRole("button", { name: /收藏/ })).toHaveCount(0);

  await safeGoto(seller, `/products/${productId}`);
  await expect(seller.getByRole("heading", { name: title })).toBeVisible();
  await expect(seller.getByText("该商品已进入预订流程，交易进行中").first()).toBeVisible();

  // ---------- 买家取消订单 → 预留释放 → 公开重新可见（§64 收尾） ----------
  await safeGoto(buyer, "/my/orders");
  const buyerOrderCard = buyer.locator("article", { hasText: title }).first();
  await buyerOrderCard.getByRole("button", { name: "取消订单" }).click();
  await buyer.getByRole("button", { name: "确认取消" }).click();
  // OrderCancelDialog 成功后会 window.location.reload() 整页刷新 /my/orders。
  // 先等 reload 后的 DOM 呈现 CANCELLED 徽标（应用自身导航 settle），再发起
  // 下一条 goto——否则该 reload 会打断 safeGoto（CI run 37316790078 的 flaky）。
  await expect(
    buyer
      .locator("article", { hasText: title })
      .first()
      .getByText("订单已取消")
      .first(),
  ).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => {
      const order = await e2eDb().order.findFirst({ where: { productId } });
      return order?.status;
    })
    .toBe("CANCELLED");
  await expect
    .poll(async () => (await e2eDb().product.findUnique({ where: { id: productId } }))?.status)
    .toBe("ACTIVE");

  await safeGoto(buyer, "/products");
  await buyer.locator('input[name="q"]').first().fill(tag);
  await buyer.keyboard.press("Enter");
  await expect(buyer.getByRole("link", { name: new RegExp(title) }).first()).toBeVisible();

  await sellerContext.close();
  await buyerContext.close();
});

test("8F-E2E-02 服务生命周期：暂停接单公开隐藏、恢复公开、owner 管理连续", async ({ browser }) => {
  const tag = uniqueTag("p8f2");
  const title = `E2E8F服务 ${tag}`;

  const sellerContext = await browser.newContext({ storageState: storageStatePath("seller") });
  const seller = await sellerContext.newPage();
  await safeGoto(seller, "/services/new");
  await seller.locator('input[name="title"]').first().fill(title);
  await seller.locator('textarea[name="description"]').first().fill(`E2E 8F 服务描述 ${tag}`);
  await seller.locator('select[name="categoryId"]').first().selectOption({ label: "摄影" });
  await seller.locator('input[name="price"]').first().fill("128");
  await seller.locator('select[name="pricingUnit"]').first().selectOption({ label: "每次" });
  await seller.locator('input[name="locationText"]').first().fill("E2E 线上");
  await seller.getByRole("button", { name: "发布服务" }).click();
  await seller.waitForURL(/\/services\/(?!new)[^/]+$/, { timeout: 30_000 });
  const serviceId = new URL(seller.url()).pathname.split("/").pop() ?? "";
  await expect
    .poll(async () => (await e2eDb().serviceListing.findUnique({ where: { id: serviceId } }))?.status)
    .toBe("ACTIVE");

  // ---------- 无关用户：公开可见 ----------
  const outsiderContext = await browser.newContext({ storageState: storageStatePath("outsider") });
  const outsider = await outsiderContext.newPage();
  await safeGoto(outsider, "/services");
  await outsider.locator('input[name="q"]').first().fill(tag);
  await outsider.keyboard.press("Enter");
  await expect(outsider.getByRole("link", { name: new RegExp(title) }).first()).toBeVisible();

  // ---------- 卖家：暂停接单（生产 UI）→ 公开列表/详情隐藏 ----------
  await safeGoto(seller, "/my/services");
  const serviceCard = seller.locator("article", { hasText: title }).first();
  await serviceCard.getByRole("button", { name: "暂停接单" }).click();
  await expect
    .poll(async () => (await e2eDb().serviceListing.findUnique({ where: { id: serviceId } }))?.status)
    .toBe("PAUSED");

  await safeGoto(outsider, "/services");
  await outsider.locator('input[name="q"]').first().fill(tag);
  await outsider.keyboard.press("Enter");
  await expect(outsider.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);

  await safeGoto(outsider, `/services/${serviceId}`);
  await expect(outsider.getByRole("heading", { name: "页面不存在" })).toBeVisible();

  // owner 管理面仍然可见（§16 wind-down continuity）
  await safeGoto(seller, "/my/services");
  await expect(seller.locator("article", { hasText: title }).first()).toBeVisible();

  // ---------- 恢复接单 → 公开重新可见 ----------
  await seller.locator("article", { hasText: title }).first().getByRole("button", { name: "恢复接单" }).click();
  await expect
    .poll(async () => (await e2eDb().serviceListing.findUnique({ where: { id: serviceId } }))?.status)
    .toBe("ACTIVE");
  await safeGoto(outsider, "/services");
  await outsider.locator('input[name="q"]').first().fill(tag);
  await outsider.keyboard.press("Enter");
  await expect(outsider.getByRole("link", { name: new RegExp(title) }).first()).toBeVisible();

  await sellerContext.close();
  await outsiderContext.close();
});

test("8F-E2E-03 租赁生命周期：暂停/恢复 + 租客下单后删除 DENY 提示可见", async ({ browser }) => {
  const tag = uniqueTag("p8f3");
  const title = `E2E8F租赁 ${tag}`;

  function localDateTime(offsetHours: number): string {
    const date = new Date(Date.now() + offsetHours * 3_600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  const ownerContext = await browser.newContext({ storageState: storageStatePath("seller") });
  acceptDialogs(await ownerContext.newPage());
  const owner = await ownerContext.newPage();
  acceptDialogs(owner);
  await safeGoto(owner, "/rentals/new");
  await owner.locator('input[name="title"]').first().fill(title);
  await owner.locator('select[name="categoryId"]').first().selectOption({ label: "相机 / 摄影器材" });
  await owner.locator('select[name="condition"]').first().selectOption({ label: "99新" });
  await owner.locator('input[name="price"]').first().fill("50");
  await owner.locator('input[name="depositAmount"]').first().fill("0");
  await owner.locator('input[name="minimumDuration"]').first().fill("1");
  await owner.locator('input[name="maximumDuration"]').first().fill("24");
  await owner.locator('input[name="pickupLocation"]').first().fill("E2E 快递驿站");
  await owner.locator('input[name="returnLocation"]').first().fill("E2E 快递驿站");
  await owner.locator('textarea[name="description"]').first().fill(`E2E 8F 租赁描述 ${tag}`);
  await owner.getByRole("button", { name: "发布租赁" }).first().click();
  await expect(owner.getByRole("heading", { level: 1, name: "出租物品管理" })).toBeVisible({
    timeout: 30_000,
  });
  const listingLink = owner.locator('a[href^="/rentals/"]', { hasText: title }).first();
  const rentalListingId = (await listingLink.getAttribute("href"))?.split("/").pop() ?? "";
  await expect
    .poll(async () => (await e2eDb().rentalListing.findUnique({ where: { id: rentalListingId } }))?.status)
    .toBe("AVAILABLE");

  // ---------- 租客：公开可见 → 暂停出租 → 公开隐藏、owner 可见 ----------
  const renterContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const renter = await renterContext.newPage();
  await safeGoto(renter, "/rentals");
  await renter.locator('input[name="q"]').first().fill(tag);
  await renter.keyboard.press("Enter");
  await expect(renter.getByRole("link", { name: new RegExp(title) }).first()).toBeVisible();

  // Phase 8F 修复后的 my/rental-listings 状态按钮（hidden 字段名对齐 listingId）；
  // 行锚点 = 含该 listing 链接的最近 rounded-3xl 行容器
  await rentalRow(owner, rentalListingId).getByRole("button", { name: "暂停出租" }).click();
  await expect
    .poll(async () => (await e2eDb().rentalListing.findUnique({ where: { id: rentalListingId } }))?.status)
    .toBe("PAUSED");

  await safeGoto(renter, "/rentals");
  await renter.locator('input[name="q"]').first().fill(tag);
  await renter.keyboard.press("Enter");
  await expect(renter.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);

  const outsiderContext = await browser.newContext();
  const outsider = await outsiderContext.newPage();
  await safeGoto(outsider, `/rentals/${rentalListingId}`);
  await expect(outsider.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await outsiderContext.close();

  // owner view：详情可见 + wind-down 横幅（§45）
  await safeGoto(owner, `/rentals/${rentalListingId}`);
  await expect(owner.getByRole("heading", { name: title })).toBeVisible();
  await expect(owner.getByText("该租赁物品当前暂停出租").first()).toBeVisible();
  await expect(owner.getByRole("button", { name: "立即租用" })).toHaveCount(0);

  // ---------- 恢复出租 → 租客下单 → owner 删除 DENY（§70 提示可见） ----------
  await safeGoto(owner, "/my/rental-listings");
  await rentalRow(owner, rentalListingId).getByRole("button", { name: "恢复出租" }).click();
  await expect
    .poll(async () => (await e2eDb().rentalListing.findUnique({ where: { id: rentalListingId } }))?.status)
    .toBe("AVAILABLE");

  await safeGoto(renter, `/rentals/${rentalListingId}`);
  await expect(async () => {
    await renter.getByRole("button", { name: "立即租用" }).first().click();
    await expect(renter.getByRole("heading", { name: "确认提交物品租赁订单" })).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 30_000 });
  await renter.locator('input[name="startTime"]').fill(localDateTime(2));
  await renter.locator('input[name="endTime"]').fill(localDateTime(26));
  await renter.getByRole("button", { name: "提交租赁订单" }).click();
  await renter.waitForURL(/\/rental-orders\/[^/]+$/, { timeout: 20_000 });
  const orderId = new URL(renter.url()).pathname.split("/").pop() ?? "";
  await expect
    .poll(async () => (await e2eDb().rentalOrder.findUnique({ where: { id: orderId } }))?.status)
    .toBe("PENDING_APPROVAL");

  // owner 详情页删除：确认框接受 → ACTIVE_OBLIGATION 中文提示（不再 silent no-op）
  await safeGoto(owner, `/rentals/${rentalListingId}`);
  await owner.getByRole("button", { name: "删除物品" }).click();
  await expect(owner.getByText(/进行中的租赁订单/).first()).toBeVisible({ timeout: 15_000 });
  expect(
    (await e2eDb().rentalListing.findUnique({ where: { id: rentalListingId } }))?.deletedAt,
  ).toBeNull();

  await ownerContext.close();
  await renterContext.close();
});

test("8F-E2E-04 跑腿生命周期：CLAIMED 后公开消失、参与方上下文保留、陌生第三方 404", async ({ browser }) => {
  const tag = uniqueTag("p8f4");
  const title = `E2E8F跑腿 ${tag}`;

  function localDateTime(offsetHours: number): string {
    const date = new Date(Date.now() + offsetHours * 3_600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  // ---------- 发布者（buyer）发布 OPEN 任务 ----------
  const publisherContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const publisher = await publisherContext.newPage();
  await safeGoto(publisher, "/errands/new");
  await publisher.locator('input[name="title"]').first().fill(title);
  await publisher.locator('textarea[name="description"]').first().fill(`E2E 8F 跑腿描述 ${tag}`);
  await publisher.locator('select[name="categoryId"]').first().selectOption({ label: "代取快递" });
  await publisher.locator('input[name="reward"]').first().fill("8.8");
  await publisher.locator('input[name="pickupLocation"]').first().fill("E2E 东区快递站");
  await publisher.locator('input[name="deliveryLocation"]').first().fill("E2E 3号楼 402");
  await publisher.locator('input[name="deadline"]').first().fill(localDateTime(3));
  await publisher.getByRole("button", { name: "发布任务" }).first().click();
  await publisher.waitForURL(/\/errands\/(?!new)[^/]+$/, { timeout: 30_000 });
  const errandId = new URL(publisher.url()).pathname.split("/").pop() ?? "";
  await expect
    .poll(async () => (await e2eDb().errandTask.findUnique({ where: { id: errandId } }))?.status)
    .toBe("OPEN");

  // ---------- 接单者（seller）公开列表可见 → 接单 → CLAIMED ----------
  const accepterContext = await browser.newContext({ storageState: storageStatePath("seller") });
  const accepter = await accepterContext.newPage();
  await safeGoto(accepter, "/errands");
  await accepter.locator('input[name="q"]').first().fill(tag);
  await accepter.keyboard.press("Enter");
  await expect(accepter.getByRole("link", { name: new RegExp(title) }).first()).toBeVisible();

  await safeGoto(accepter, `/errands/${errandId}`);
  await expect(async () => {
    await accepter.getByRole("button", { name: "立即接单" }).first().click();
    await expect(accepter.getByRole("button", { name: "确认接单" })).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await accepter.getByRole("button", { name: "确认接单" }).first().click();
  await expect
    .poll(async () => (await e2eDb().errandTask.findUnique({ where: { id: errandId } }))?.status)
    .toBe("CLAIMED");

  // ---------- 公开曝光收敛：/errands 列表不再出现；陌生第三方 404 ----------
  const outsiderContext = await browser.newContext();
  const outsider = await outsiderContext.newPage();
  await safeGoto(outsider, "/errands");
  await outsider.locator('input[name="q"]').first().fill(tag);
  await outsider.keyboard.press("Enter");
  await expect(outsider.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);
  await safeGoto(outsider, `/errands/${errandId}`);
  await expect(outsider.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await outsiderContext.close();

  // ---------- publisher / accepter 履约上下文保留（§17）+ wind-down 提示 ----------
  await safeGoto(publisher, `/errands/${errandId}`);
  await expect(publisher.getByRole("heading", { name: title })).toBeVisible();
  await expect(publisher.getByText("该跑腿任务已被接单，进入履约流程").first()).toBeVisible();

  await safeGoto(accepter, `/errands/${errandId}`);
  await expect(accepter.getByRole("heading", { name: title })).toBeVisible();
  await expect(accepter.getByText("该跑腿任务已被接单，进入履约流程").first()).toBeVisible();

  await publisherContext.close();
  await accepterContext.close();
});

test("8F-E2E-05 移动端 390x844：owner lifecycle 面操作可用、删除确认可用、无横向溢出、无 raw enum", async ({ browser }) => {
  const tag = uniqueTag("p8f5");
  const title = `E2E8F移动 ${tag}`;

  const ownerContext = await browser.newContext({
    storageState: storageStatePath("seller"),
    viewport: { width: 390, height: 844 },
  });
  const owner = await ownerContext.newPage();
  await safeGoto(owner, "/rentals/new");
  await owner.locator('input[name="title"]').first().fill(title);
  await owner.locator('select[name="categoryId"]').first().selectOption({ label: "相机 / 摄影器材" });
  await owner.locator('select[name="condition"]').first().selectOption({ label: "99新" });
  await owner.locator('input[name="price"]').first().fill("50");
  await owner.locator('input[name="depositAmount"]').first().fill("0");
  await owner.locator('input[name="minimumDuration"]').first().fill("1");
  await owner.locator('input[name="maximumDuration"]').first().fill("24");
  await owner.locator('input[name="pickupLocation"]').first().fill("E2E 快递驿站");
  await owner.locator('input[name="returnLocation"]').first().fill("E2E 快递驿站");
  await owner.locator('textarea[name="description"]').first().fill(`E2E 8F 移动租赁 ${tag}`);
  await owner.getByRole("button", { name: "发布租赁" }).first().click();
  await expect(owner.getByRole("heading", { level: 1, name: "出租物品管理" })).toBeVisible({
    timeout: 30_000,
  });
  const listingLink = owner.locator('a[href^="/rentals/"]', { hasText: title }).first();
  const rentalListingId = (await listingLink.getAttribute("href"))?.split("/").pop() ?? "";

  // 无横向溢出 + 无 raw enum（§68：owner lifecycle 面）
  for (const path of ["/my/rental-listings", "/my/products", "/my/services", "/my/errands"]) {
    await safeGoto(owner, path);
    await expect(owner.locator("body")).toBeVisible();
    const overflow = await owner.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow, `${path} 存在横向溢出`).toBe(false);
    const bodyText = await owner.locator("body").innerText();
    expect(bodyText, `${path} 泄漏 raw enum AVAILABLE`).not.toContain("AVAILABLE");
    expect(bodyText, `${path} 泄漏 raw enum RESERVED`).not.toContain("RESERVED");
    expect(bodyText, `${path} 泄漏 raw enum OFFLINE`).not.toContain("OFFLINE");
    expect(bodyText, `${path} 泄漏 raw enum PAUSED`).not.toContain("PAUSED");
  }

  // status action 可用（移动端点击 暂停出租 → DB PAUSED）
  await safeGoto(owner, "/my/rental-listings");
  await rentalRow(owner, rentalListingId).getByRole("button", { name: "暂停出租" }).click();
  await expect
    .poll(async () => (await e2eDb().rentalListing.findUnique({ where: { id: rentalListingId } }))?.status)
    .toBe("PAUSED");

  // 删除确认可用（移动端 → confirm 对话框弹出即视为可用；拒绝后零副作用）。
  // waitForEvent 会禁用 Playwright 自动 dismiss——click 与 dialog 处理必须
  // 解耦（confirm 同步阻塞页面 JS，click 在对话框处理完前不会返回）
  const rentalDetail = await ownerContext.newPage();
  const dialogPromise = rentalDetail.waitForEvent("dialog", { timeout: 15_000 });
  await safeGoto(rentalDetail, `/rentals/${rentalListingId}`);
  const clickPromise = rentalDetail
    .getByRole("button", { name: "删除物品" })
    .click()
    .catch(() => undefined);
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain("不会恢复公开展示");
  await dialog.dismiss();
  await clickPromise;
  expect(
    (await e2eDb().rentalListing.findUnique({ where: { id: rentalListingId } }))?.deletedAt,
  ).toBeNull();

  await ownerContext.close();
});
