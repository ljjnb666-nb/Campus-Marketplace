import { test, expect } from "@playwright/test";
import { storageStatePath, uniqueTag } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";

/**
 * GOLDEN FLOW 7 — 双用户站内消息（轮询/刷新即可，无 WebSocket）
 * A 从商品详情私聊卖家建立会话 → 发消息 → B 消息中心看到并回复 → A 刷新看到回复
 */

test("站内消息：买家私聊卖家 → 双向收发 → 刷新后仍存在", async ({ browser }) => {
  const tag = uniqueTag("gf7");
  const title = `E2E消息商品 ${tag}`;
  const buyerMessage = `你好，我想咨询 ${tag}`;
  const sellerReply = `卖家回复 ${tag}`;

  // ---------- 卖家发布商品（会话载体） ----------
  const sellerContext = await browser.newContext({ storageState: storageStatePath("seller") });
  const seller = await sellerContext.newPage();
  await seller.goto("/products/new");
  await seller.locator('input[name="title"]').first().fill(title);
  await seller.locator('select[name="categoryId"]').first().selectOption({ label: "体育用品" });
  await seller.locator('input[name="price"]').first().fill("39.9");
  await seller.locator('input[name="locationText"]').first().fill("E2E 操场东门");
  await seller.locator('textarea[name="description"]').first().fill(`E2E 消息链路 ${tag}`);
  await seller.getByRole("button", { name: "确认发布商品" }).click();
  await seller.waitForURL(/\/products\/(?!new)[^/]+$/, { timeout: 30_000 });
  const productId = new URL(seller.url()).pathname.split("/").pop() ?? "";

  // ---------- 买家私聊卖家 → 建立会话并发送第一条消息 ----------
  const buyerContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const buyer = await buyerContext.newPage();
  await buyer.goto(`/products/${productId}`);
  await buyer.getByRole("button", { name: "私聊卖家" }).click();
  await buyer.waitForURL(/\/messages\/[^/]+$/, { timeout: 20_000 });
  const conversationId = new URL(buyer.url()).pathname.split("/").pop() ?? "";

  // 聊天输入区为 ChatInput 组件（受控 textarea + 图标发送按钮）
  const buyerComposer = buyer.getByPlaceholder(/输入沟通内容/).first();
  await buyerComposer.fill(buyerMessage);
  await buyerComposer.press("Enter");
  await expect(buyer.getByText(buyerMessage).first()).toBeVisible({ timeout: 15_000 });

  // ---------- 卖家在消息中心看到会话与消息，并回复 ----------
  // /messages 是列表+详情双栏布局：列表项为 div（点击软导航），非 <a>
  await seller.goto("/messages");
  const conversationItem = seller.getByText(title, { exact: false }).first();
  await expect(conversationItem).toBeVisible({ timeout: 15_000 });
  await conversationItem.click();
  await seller.waitForURL(/\/messages\/[^/]+$/, { waitUntil: "commit" });
  await expect(seller.getByText(buyerMessage).first()).toBeVisible();

  const sellerComposer = seller.getByPlaceholder(/输入沟通内容/).first();
  await sellerComposer.fill(sellerReply);
  await sellerComposer.press("Enter");
  await expect(seller.getByText(sellerReply).first()).toBeVisible({ timeout: 15_000 });

  // ---------- 买家重新进入会话看到回复（刷新语义） ----------
  await buyer.goto(`/messages/${conversationId}`);
  await expect(buyer.getByText(buyerMessage).first()).toBeVisible();
  await expect(buyer.getByText(sellerReply).first()).toBeVisible();

  // ---------- DB：消息、发送者、会话归属 ----------
  // 会话创建时系统自动带一条“你好，我想咨询…”开场消息，随后是买家两条真实往返
  const conversation = await e2eDb().conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      participants: true,
    },
  });
  expect(conversation?.title).toContain(title);
  expect(conversation?.messages.length).toBe(3);
  expect(conversation?.messages[1].content).toBe(buyerMessage);
  expect(conversation?.messages[2].content).toBe(sellerReply);

  const [buyerUser, sellerUser] = await Promise.all([
    e2eDb().user.findUnique({ where: { email: "e2e-buyer@e2e.test" } }),
    e2eDb().user.findUnique({ where: { email: "e2e-seller@e2e.test" } }),
  ]);
  expect(conversation?.messages[1].senderId).toBe(buyerUser?.id);
  expect(conversation?.messages[2].senderId).toBe(sellerUser?.id);
  expect(
    conversation?.participants.map((participant) => participant.userId).sort(),
  ).toEqual([buyerUser?.id, sellerUser?.id].sort());

  await sellerContext.close();
  await buyerContext.close();
});
