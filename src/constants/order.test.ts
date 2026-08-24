import { describe, expect, it } from "vitest";
import {
  ORDER_STATUS_LABELS,
  ORDER_TYPE_LABELS,
  PAYMENT_STATUS_LABELS,
} from "@/constants/order";

describe("order constants", () => {
  it("maps every order status to a Chinese label", () => {
    expect(ORDER_STATUS_LABELS.PENDING).toBe("待确认");
    expect(ORDER_STATUS_LABELS.ACCEPTED).toBe("已接单");
    expect(ORDER_STATUS_LABELS.IN_PROGRESS).toBe("进行中");
    expect(ORDER_STATUS_LABELS.COMPLETED).toBe("已完成");
    expect(ORDER_STATUS_LABELS.CANCELLED).toBe("已取消");
    expect(ORDER_STATUS_LABELS.REFUNDED).toBe("已退款");
  });

  it("maps order types and payment statuses", () => {
    expect(ORDER_TYPE_LABELS.PRODUCT).toBe("商品订单");
    expect(ORDER_TYPE_LABELS.ERRAND).toBe("跑腿订单");
    expect(ORDER_TYPE_LABELS.SERVICE).toBe("服务订单");

    expect(PAYMENT_STATUS_LABELS.UNPAID).toBe("未支付");
    expect(PAYMENT_STATUS_LABELS.OFFLINE_PENDING).toBe("线下待支付");
    expect(PAYMENT_STATUS_LABELS.PAID).toBe("已支付");
    expect(PAYMENT_STATUS_LABELS.REFUNDED).toBe("已退款");
  });
});
