import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  initiateOrderDisputeTx,
  withTransaction,
  revalidateOrderViews,
  requireUser,
  loggerError,
} = vi.hoisted(() => ({
  initiateOrderDisputeTx: vi.fn(),
  withTransaction: vi.fn(),
  revalidateOrderViews: vi.fn(),
  requireUser: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/order-dispute-machine", () => ({ initiateOrderDisputeTx }));
vi.mock("@/lib/prisma", () => ({ withTransaction }));
vi.mock("@/lib/revalidate", () => ({ revalidateOrderViews }));
vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/logger", () => ({ logger: { error: loggerError, warn: vi.fn(), info: vi.fn() } }));

import { initiateGeneralOrderDispute } from "@/actions/order-dispute";
import { rbacError } from "@/lib/rbac/errors";

/**
 * Phase 8C-02：General Order dispute 用户入口薄适配层合同
 * （validate → requireUser → withTransaction → canonical
 * initiateOrderDisputeTx → revalidate → safe response）。
 *
 * 指令 §55：participant/status/type/campus/active dispute 的裁决全部在
 * canonical 服务锁内 fresh check——action 层零域判断复制；
 * evidencePhotos 恒 []（8C-02 不开放附件）。
 */

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    fd.set(k, v);
  }
  return fd;
}

const SUCCESS_RESULT = {
  success: true,
  disputeId: "dispute-1",
  productId: "product-1",
  serviceListingId: null,
  errandTaskId: null,
};

beforeEach(() => {
  for (const fn of [initiateOrderDisputeTx, withTransaction, revalidateOrderViews, requireUser, loggerError]) {
    fn.mockReset();
  }
  requireUser.mockResolvedValue({ id: "user-1" });
  withTransaction.mockImplementation(async (fn: (tx: symbol) => Promise<unknown>) => fn(Symbol("tx")));
});

describe("initiateGeneralOrderDispute（USER-OD）", () => {
  it("USER-OD-01：valid PRODUCT → canonical 服务被调用（evidencePhotos 恒 []）+ revalidate context", async () => {
    initiateOrderDisputeTx.mockResolvedValue(SUCCESS_RESULT);

    const result = await initiateGeneralOrderDispute(
      formData({ orderId: "order-1", reason: "商品与描述不符，要求处理" }),
    );

    expect(result).toEqual({ success: true, message: "纠纷已提交，订单已进入处理流程" });
    expect(initiateOrderDisputeTx).toHaveBeenCalledTimes(1);
    const [tx, input] = initiateOrderDisputeTx.mock.calls[0];
    expect(input).toEqual({
      orderId: "order-1",
      userId: "user-1",
      reason: "商品与描述不符，要求处理",
      evidencePhotos: [],
    });
    expect(tx).toBeDefined();
    expect(revalidateOrderViews).toHaveBeenCalledWith({ productId: "product-1" });
  });

  it("USER-OD-02：valid SERVICE → canonical 服务 + serviceListingId revalidate", async () => {
    initiateOrderDisputeTx.mockResolvedValue({
      success: true,
      disputeId: "dispute-2",
      productId: null,
      serviceListingId: "service-1",
      errandTaskId: null,
    });

    const result = await initiateGeneralOrderDispute(
      formData({ orderId: "order-2", reason: "服务未按约定交付" }),
    );

    expect(result.success).toBe(true);
    expect(revalidateOrderViews).toHaveBeenCalledWith({ serviceId: "service-1" });
  });

  it("USER-OD-03：valid ERRAND → canonical 服务 + errandTaskId revalidate", async () => {
    initiateOrderDisputeTx.mockResolvedValue({
      success: true,
      disputeId: "dispute-3",
      productId: null,
      serviceListingId: null,
      errandTaskId: "errand-1",
    });

    const result = await initiateGeneralOrderDispute(
      formData({ orderId: "order-3", reason: "跑腿任务超时未送达" }),
    );

    expect(result.success).toBe(true);
    expect(revalidateOrderViews).toHaveBeenCalledWith({ errandId: "errand-1" });
  });

  it("USER-OD-04：invalid reason（<5 字 / >1000 字 / 缺 orderId）→ 参数错误，canonical 服务零调用", async () => {
    const invalidPayloads: Array<Record<string, string>> = [
      { orderId: "order-1", reason: "太短" },
      { orderId: "order-1", reason: "" },
      { orderId: "order-1", reason: "字".repeat(1001) },
      { reason: "没有订单号的纠纷原因" },
    ];
    for (const payload of invalidPayloads) {
      const result = await initiateGeneralOrderDispute(formData(payload));
      expect(result.success).toBe(false);
      expect(result.message).toBeTruthy();
    }
    expect(initiateOrderDisputeTx).not.toHaveBeenCalled();
    expect(revalidateOrderViews).not.toHaveBeenCalled();
  });

  it("USER-OD-05：unauthenticated → requireUser 处理（redirect），canonical 服务零调用", async () => {
    requireUser.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(
      initiateGeneralOrderDispute(formData({ orderId: "order-1", reason: "商品与描述不符，要求处理" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(initiateOrderDisputeTx).not.toHaveBeenCalled();
  });

  it("USER-OD-06：domain deny（{ error }）→ 直接映射安全文案，零 revalidate", async () => {
    initiateOrderDisputeTx.mockResolvedValue({ error: "该订单已有进行中的纠纷" });

    const result = await initiateGeneralOrderDispute(
      formData({ orderId: "order-1", reason: "商品与描述不符，要求处理" }),
    );

    expect(result).toEqual({ success: false, message: "该订单已有进行中的纠纷" });
    expect(revalidateOrderViews).not.toHaveBeenCalled();
  });

  it("USER-OD-06b：已知 RBAC inactive 错误 → 返回其现有安全 userMessage", async () => {
    initiateOrderDisputeTx.mockRejectedValue(rbacError("AUTH_ACCOUNT_INACTIVE"));

    const result = await initiateGeneralOrderDispute(
      formData({ orderId: "order-1", reason: "商品与描述不符，要求处理" }),
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe(rbacError("AUTH_ACCOUNT_INACTIVE").message);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("USER-OD-07：success → revalidate 使用 domain result 的精确 context", async () => {
    initiateOrderDisputeTx.mockResolvedValue(SUCCESS_RESULT);

    await initiateGeneralOrderDispute(formData({ orderId: "order-1", reason: "商品与描述不符，要求处理" }));

    expect(revalidateOrderViews).toHaveBeenCalledTimes(1);
    expect(revalidateOrderViews).toHaveBeenCalledWith({ productId: "product-1" });
  });

  it("USER-OD-08：evidencePhotos 恒传 []（即使 FormData 塞入文件字段也不解析）", async () => {
    initiateOrderDisputeTx.mockResolvedValue(SUCCESS_RESULT);

    const fd = formData({ orderId: "order-1", reason: "商品与描述不符，要求处理" });
    fd.set("evidencePhotos", "asset:fake-1");

    await initiateGeneralOrderDispute(fd);

    expect(initiateOrderDisputeTx.mock.calls[0][1].evidencePhotos).toEqual([]);
  });

  it("未知异常 → 统一兜底文案 + logger（raw error 不回浏览器）", async () => {
    initiateOrderDisputeTx.mockRejectedValue(new Error("P9999 raw prisma boom"));

    const result = await initiateGeneralOrderDispute(
      formData({ orderId: "order-1", reason: "商品与描述不符，要求处理" }),
    );

    expect(result).toEqual({ success: false, message: "提交纠纷失败，请稍后重试" });
    expect(loggerError).toHaveBeenCalledTimes(1);
  });
});
