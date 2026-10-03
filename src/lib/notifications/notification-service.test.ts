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
      // RB04 winner validation：默认返回与 createMany 写入行一致的全量
      // winner（各测试可覆盖 mockResolvedValue / mockImplementation）
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ email: "rcpt@campus.test", erasedAt: null }),
    },
    notificationDelivery: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ id: "delivery-1", suppressedAt: new Date() }),
    },
  } as unknown as Prisma.TransactionClient & {
    notification: {
      createMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
    user: { findUnique: ReturnType<typeof vi.fn> };
    notificationDelivery: {
      createMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
}

/** RB04：按 emit intent 构造匹配的 dedupe winner 行（findUnique stub 用）。 */
function winnerRowFor(intent: {
  recipientUserId: string;
  kind: string;
  schemaVersion?: number;
  dedupeKey: string;
  payload: unknown;
  orderId?: string | null;
  sourceEventId?: string | null;
}) {
  return {
    id: "notification-1",
    userId: intent.recipientUserId,
    kind: intent.kind,
    schemaVersion: intent.schemaVersion ?? 1,
    payload: intent.payload,
    orderId: intent.orderId ?? null,
    sourceEventId: intent.sourceEventId ?? null,
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

  it("EMAIL 渠道 kind 必须注册 renderEmail（registry 完整性，§38）", () => {
    for (const definition of listRegisteredNotificationDefinitions()) {
      if (definition.channels.includes("EMAIL")) {
        expect(definition.renderEmail, `${definition.kind} 缺少 renderEmail`).toBeTypeOf(
          "function",
        );
      }
    }
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
    const intent = {
      kind: PRODUCT_RESERVATION_EXPIRED_KIND,
      recipientUserId: "buyer-1",
      dedupeKey: "OUTBOX:e1:IN_APP:buyer-1",
      sourceEventId: "e1",
      orderId: "o1",
      payload: { orderId: "o1", buyerId: "buyer-1", sellerId: "seller-1" },
    } as const;
    (tx.notification.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      winnerRowFor(intent),
    );
    const result = await emitNotificationTx(tx, intent);

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
      select: {
        id: true,
        userId: true,
        kind: true,
        schemaVersion: true,
        payload: true,
        orderId: true,
        sourceEventId: true,
      },
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
    const intents = [
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
    ];
    (tx.notification.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { dedupeKey: string } }) => {
        const intent = intents.find((entry) => entry.dedupeKey === args.where.dedupeKey)!;
        return Promise.resolve(winnerRowFor(intent));
      },
    );
    const results = await emitNotificationsTx(tx, intents);
    expect(results).toEqual([
      { notificationId: "notification-1" },
      { notificationId: "notification-1" },
    ]);
    expect(tx.notification.createMany).toHaveBeenCalledTimes(2);
  });

  it("RB04 winner validation：insert 被跳过（count=0）且 payload 形状漂移 → NOTIFICATION_DEDUPE_COLLISION（不物化渠道）", async () => {
    const tx = txStub();
    const intent = {
      kind: PRODUCT_RESERVATION_EXPIRED_KIND,
      recipientUserId: "buyer-1",
      dedupeKey: "OUTBOX:e1:IN_APP:buyer-1",
      sourceEventId: "e1",
      orderId: "o1",
      payload: { orderId: "o1", buyerId: "buyer-1", sellerId: "seller-1" },
    } as const;
    // createMany 返回 count=0：本方 insert 被 skipDuplicates 跳过——winner
    // 可能是别的 intent 的行 → 必须身份校验（findUnique 返回漂移 payload）
    (tx.notification.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    (tx.notification.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      winnerRowFor({ ...intent, payload: { orderId: "o-DIFFERENT", buyerId: "buyer-1", sellerId: "seller-1" } }),
    );

    await expect(emitNotificationTx(tx, intent)).rejects.toMatchObject({
      code: "NOTIFICATION_DEDUPE_COLLISION",
    });
    expect(tx.notificationDelivery.createMany).not.toHaveBeenCalled();
  });

  it("RB04：insert 被跳过但 winner 与 intent 完全一致 → 幂等成功（same id）", async () => {
    const tx = txStub();
    const intent = {
      kind: PRODUCT_RESERVATION_EXPIRED_KIND,
      recipientUserId: "buyer-1",
      dedupeKey: "OUTBOX:e1:IN_APP:buyer-1",
      sourceEventId: "e1",
      orderId: "o1",
      payload: { orderId: "o1", buyerId: "buyer-1", sellerId: "seller-1" },
    } as const;
    (tx.notification.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    (tx.notification.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      winnerRowFor(intent),
    );

    await expect(emitNotificationTx(tx, intent)).resolves.toEqual({
      notificationId: "notification-1",
    });
  });
});
