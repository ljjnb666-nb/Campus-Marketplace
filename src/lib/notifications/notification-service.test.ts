import type { Prisma } from "@prisma/client";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { PermanentJobFailure } from "@/lib/async/job-types";
import {
  listRegisteredNotificationDefinitions,
  NOTIFICATION_SCHEMA_VERSION,
  NotificationIntentContractError,
  parseNotificationPayload,
  PRODUCT_RESERVATION_EXPIRED_KIND,
  resolveNotificationDefinition,
  validateNotificationIntent,
} from "./notification-registry";
import { emitNotificationTx, emitNotificationsTx } from "./notification-service";

/**
 * Phase 9B unit contracts（§6/§7/§16/§17）：
 * - registry：kind/version 解析 fail closed；payload strict（未知键拒绝）；
 *   渲染文案与既有业务 copy 逐字一致；
 * - service：write-time strict validation、dedupe 必填、exactly-once 写入
 *   形状（createMany skipDuplicates + findUnique 复用 winner）。
 */

function txStub() {
  return {
    notification: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ id: "notification-1" }),
    },
  } as unknown as Prisma.TransactionClient & {
    notification: {
      createMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
}

describe("notification registry（contract layer）", () => {
  it("所有注册 definition 具备完整契约（kind/version/schema/channels/renderInApp）", () => {
    const definitions = listRegisteredNotificationDefinitions();
    expect(definitions.length).toBeGreaterThanOrEqual(30);
    const seen = new Set<string>();
    // 任意字段访问都返回字符串的 probe（渲染器只消费 IDs/机器状态字符串）
    const probePayload = new Proxy({}, { get: () => "x" }) as never;
    for (const definition of definitions) {
      expect(seen.has(definition.kind)).toBe(false);
      seen.add(definition.kind);
      expect(definition.schemaVersion).toBe(NOTIFICATION_SCHEMA_VERSION);
      expect(definition.channels).toContain("IN_APP");
      expect(typeof definition.renderInApp).toBe("function");
      const probe = definition.renderInApp(probePayload, "user-x");
      expect(probe.title.length).toBeGreaterThan(0);
      expect(probe.content.length).toBeGreaterThan(0);
    }
  });

  it("未知 kind / version 解析返回 null（fail closed）", () => {
    expect(resolveNotificationDefinition("NO_SUCH_KIND", 1)).toBeNull();
    expect(resolveNotificationDefinition(PRODUCT_RESERVATION_EXPIRED_KIND, 99)).toBeNull();
  });

  it("write-time validation：payload 未知键即 INVALID（strict，绝不 silently strip）", () => {
    const ok = validateNotificationIntent(PRODUCT_RESERVATION_EXPIRED_KIND, 1, {
      orderId: "order-1",
      buyerId: "u1",
      sellerId: "u2",
    });
    expect(ok.ok).toBe(true);

    const extra = validateNotificationIntent(PRODUCT_RESERVATION_EXPIRED_KIND, 1, {
      orderId: "order-1",
      buyerId: "u1",
      sellerId: "u2",
      productTitle: "绝不允许的自由文本",
    } as Record<string, unknown>);
    expect(extra).toEqual({ ok: false, reason: "INVALID_PAYLOAD" });

    expect(validateNotificationIntent("NO_SUCH_KIND", 1, {})).toEqual({
      ok: false,
      reason: "UNKNOWN_CONTRACT",
    });
  });

  it("PRODUCT_RESERVATION_EXPIRED@1 渲染与 Phase 9A 冻结文案逐字一致（按收件人角色）", () => {
    const definition = resolveNotificationDefinition(PRODUCT_RESERVATION_EXPIRED_KIND, 1);
    expect(definition).not.toBeNull();
    const payload = { orderId: "o1", buyerId: "buyer-1", sellerId: "seller-1" };
    const buyer = definition!.renderInApp(payload as never, "buyer-1");
    const seller = definition!.renderInApp(payload as never, "seller-1");
    expect(buyer).toEqual({
      type: "ORDER",
      title: "商品预留已过期",
      content: "卖家未在确认期限内接受订单，商品预留已自动释放。",
    });
    expect(seller).toEqual({
      type: "ORDER",
      title: "商品预留已过期",
      content: "该商品订单已超过确认期限，预留已自动释放。",
    });
  });

  it("渲染只消费 payload（registry 不 import DB repository——静态合同）", async () => {
    // registry 模块源码禁止 import 任何 repository/prisma
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const source = readFileSync(
      path.join(process.cwd(), "src", "lib", "notifications", "notification-registry.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+"@\/repositories\//);
    expect(source).not.toMatch(/from\s+"@\/lib\/prisma"/);
  });

  it("read-time parse：payload 形状非法 → PermanentJobFailure（结构损坏 fail closed）", () => {
    const definition = resolveNotificationDefinition(PRODUCT_RESERVATION_EXPIRED_KIND, 1)!;
    expect(() =>
      parseNotificationPayload(
        { kind: PRODUCT_RESERVATION_EXPIRED_KIND, payload: { orderId: "o1" } },
        definition.payloadSchema as never,
      ),
    ).toThrow(expect.objectContaining({ code: "NOTIFICATION_PAYLOAD_INVALID" }) as unknown as Error);
  });
});

describe("emitNotificationTx（canonical write path）", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("write shape：createMany skipDuplicates + findUnique(dedupeKey)，kind/version/payload 落库", async () => {
    const tx = txStub();
    const result = await emitNotificationTx(tx, {
      kind: PRODUCT_RESERVATION_EXPIRED_KIND,
      recipientUserId: "buyer-1",
      dedupeKey: "OUTBOX:e1:IN_APP:buyer-1",
      sourceEventId: "e1",
      orderId: "o1",
      payload: { orderId: "o1", buyerId: "buyer-1", sellerId: "seller-1" },
    });

    expect(result).toEqual({ notificationId: "notification-1" });
    const createMany = tx.notification.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).toHaveBeenCalledTimes(1);
    const arg = createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data[0]).toMatchObject({
      userId: "buyer-1",
      orderId: "o1",
      type: "ORDER",
      title: "商品预留已过期",
      dedupeKey: "OUTBOX:e1:IN_APP:buyer-1",
      sourceEventId: "e1",
      kind: PRODUCT_RESERVATION_EXPIRED_KIND,
      schemaVersion: 1,
    });
    const findUnique = tx.notification.findUnique as ReturnType<typeof vi.fn>;
    expect(findUnique).toHaveBeenCalledWith({
      where: { dedupeKey: "OUTBOX:e1:IN_APP:buyer-1" },
      select: { id: true },
    });
  });

  it("未知 kind → NotificationIntentContractError（UNKNOWN），payload 非法 → INVALID，dedupeKey 缺失 → 拒绝", async () => {
    const tx = txStub();

    await expect(
      emitNotificationTx(tx, {
        kind: "NO_SUCH_KIND",
        recipientUserId: "u1",
        dedupeKey: "k",
        payload: {},
      }),
    ).rejects.toMatchObject({ code: "NOTIFICATION_INTENT_CONTRACT_UNKNOWN" });

    await expect(
      emitNotificationTx(tx, {
        kind: PRODUCT_RESERVATION_EXPIRED_KIND,
        recipientUserId: "u1",
        dedupeKey: "k",
        payload: { orderId: "o1" },
      }),
    ).rejects.toMatchObject({ code: "NOTIFICATION_INTENT_CONTRACT_INVALID" });

    await expect(
      emitNotificationTx(tx, {
        kind: PRODUCT_RESERVATION_EXPIRED_KIND,
        recipientUserId: "u1",
        dedupeKey: "",
        payload: { orderId: "o1", buyerId: "b", sellerId: "s" },
      }),
    ).rejects.toMatchObject({ code: "NOTIFICATION_INTENT_DEDUPE_KEY_INVALID" });

    expect(tx.notification.createMany).not.toHaveBeenCalled();
  });

  it("契约错误是 PermanentJobFailure 子类（受控机器码，RB05 合同）", () => {
    const error = new NotificationIntentContractError("UNKNOWN_CONTRACT", "K", 1);
    expect(error).toBeInstanceOf(PermanentJobFailure);
    expect(error.failureClass).toBe("PERMANENT");
    expect(error.code).toMatch(/^[A-Z][A-Z0-9_:-]{0,99}$/);
  });

  it("emitNotificationsTx 逐条 emit 并保持顺序", async () => {
    const tx = txStub();
    const results = await emitNotificationsTx(tx, [
      {
        kind: PRODUCT_RESERVATION_EXPIRED_KIND,
        recipientUserId: "buyer",
        dedupeKey: "k-buyer",
        payload: { orderId: "o", buyerId: "buyer", sellerId: "seller" },
      },
      {
        kind: PRODUCT_RESERVATION_EXPIRED_KIND,
        recipientUserId: "seller",
        dedupeKey: "k-seller",
        payload: { orderId: "o", buyerId: "buyer", sellerId: "seller" },
      },
    ]);
    expect(results).toEqual([
      { notificationId: "notification-1" },
      { notificationId: "notification-1" },
    ]);
    expect(tx.notification.createMany).toHaveBeenCalledTimes(2);
  });
});
