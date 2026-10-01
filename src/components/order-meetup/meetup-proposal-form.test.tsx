import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { proposeOrderMeetupAction } = vi.hoisted(() => ({
  proposeOrderMeetupAction: vi.fn(),
}));

vi.mock("@/actions/order-meetup", () => ({ proposeOrderMeetupAction }));

import { MeetupProposalForm } from "@/components/order-meetup/meetup-proposal-form";

/**
 * Phase 8D-02：发起见面约定表单 UX 合同。
 * 地点来源互斥（MEETUP_POINT 选点 / CUSTOM 文本，不同时提交）；长度 UX
 * 复用 meetup-policy 常量（无第二套 2..80）；a11y：label / select /
 * textbox 可访问名齐备。服务器裁决恒为 canonical proposeOrderMeetupTx。
 */

function setup() {
  proposeOrderMeetupAction.mockResolvedValue({ success: false, message: "该订单已有进行中的见面约定" });
}

beforeEach(() => {
  setup();
});

afterEach(() => {
  cleanup();
  proposeOrderMeetupAction.mockReset();
});

function locationSourceInput(): HTMLInputElement {
  const input = document.querySelector('input[name="locationSource"]');
  expect(input).toBeTruthy();
  return input as HTMLInputElement;
}

// server 预生成的 canonical campus-local input 文本（RB01-D：本测试只
// 关心 UX 合同——文本原样进入 min/defaultValue，客户端零时区换算）
const minAtLocal = "2026-10-01T12:00";
const defaultAtLocal = "2026-10-01T13:00";

function renderForm(props: Partial<Parameters<typeof MeetupProposalForm>[0]> = {}) {
  return render(
    <MeetupProposalForm
      orderId="order-1"
      meetupPointOptions={[{ id: "point-1", name: "图书馆北门", locationText: "图书馆北门台阶" }]}
      minAtLocal={minAtLocal}
      defaultAtLocal={defaultAtLocal}
      {...props}
    />,
  );
}

describe("MeetupProposalForm", () => {
  it("有校内见面点候选 → 默认 MEETUP_POINT 来源，select 可访问名可用", () => {
    renderForm({
      meetupPointOptions: [
        { id: "point-1", name: "图书馆北门", locationText: "图书馆北门台阶" },
        { id: "point-2", name: "东门", locationText: "东门岗亭旁" },
      ],
    });

    expect(screen.getByRole("radio", { name: "校内推荐见面点" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "自定义地点" })).toBeTruthy();
    const select = screen.getByRole("combobox", { name: "选择校内推荐见面点" });
    expect(select).toBeTruthy();
    // 选项文本 = name（locationText）组合
    expect((select as HTMLSelectElement).textContent).toContain("图书馆北门");
    expect((select as HTMLSelectElement).textContent).toContain("东门");
    // 默认来源：hidden input locationSource = MEETUP_POINT（enum 仅存在于
    // hidden value，非用户可见文字）
    const hidden = locationSourceInput();
    expect(hidden.value).toBe("MEETUP_POINT");
    expect(hidden.type).toBe("hidden");
    // RB01-D：min/defaultValue 原样使用 server 预生成的 campus-local 文本
    const scheduledInput = screen.getByLabelText(/约定时间/) as HTMLInputElement;
    expect(scheduledInput.min).toBe("2026-10-01T12:00");
    expect(scheduledInput.defaultValue).toBe("2026-10-01T13:00");
    // CUSTOM 文本框不渲染
    expect(screen.queryByRole("textbox", { name: "自定义见面地点" })).toBeNull();
  });

  it("无候选见面点 → 默认 CUSTOM，文本框长度 UX 复用 policy 常量", () => {
    renderForm({ meetupPointOptions: [] });

    // 无候选时不渲染 MEETUP_POINT 选项
    expect(screen.queryByRole("radio", { name: "校内推荐见面点" })).toBeNull();
    expect(screen.getByRole("radio", { name: "自定义地点" })).toBeTruthy();
    const textbox = screen.getByRole("textbox", { name: "自定义见面地点" }) as HTMLInputElement;
    expect(textbox.maxLength).toBe(80);
    const hiddenCustom = locationSourceInput();
    expect(hiddenCustom.value).toBe("CUSTOM");
  });

  it("切换来源：CUSTOM ↔ MEETUP_POINT 输入通道互斥切换", () => {
    renderForm();

    fireEvent.click(screen.getByRole("radio", { name: "自定义地点" }));
    expect(screen.getByRole("textbox", { name: "自定义见面地点" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "选择校内推荐见面点" })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "校内推荐见面点" }));
    expect(screen.getByRole("combobox", { name: "选择校内推荐见面点" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "自定义见面地点" })).toBeNull();
  });

  it("提交：FormData 携带 orderId + scheduledAt + 按来源的单一地点通道", async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText(/约定时间/), {
      target: { value: "2026-10-05T14:30" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "发起见面约定" }));

    await waitFor(() => {
      expect(proposeOrderMeetupAction).toHaveBeenCalled();
    });
    const [, fd] = proposeOrderMeetupAction.mock.calls[0] as [unknown, FormData];
    expect(fd.get("orderId")).toBe("order-1");
    expect(fd.get("scheduledAt")).toBe("2026-10-05T14:30");
    expect(fd.get("locationSource")).toBe("MEETUP_POINT");
    expect(fd.get("meetupPointId")).toBe("point-1");
    expect(fd.get("locationText")).toBeNull();

    // 领域 deny → 安全中文错误可见（role=alert）
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("该订单已有进行中的见面约定");
    });
  });

  it("提交：CUSTOM 来源只携带 locationText，meetupPointId 不下发", async () => {
    renderForm();

    fireEvent.click(screen.getByRole("radio", { name: "自定义地点" }));
    fireEvent.change(screen.getByRole("textbox", { name: "自定义见面地点" }), {
      target: { value: "东门快递柜旁" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "发起见面约定" }));

    await waitFor(() => {
      expect(proposeOrderMeetupAction).toHaveBeenCalled();
    });
    const [, fd] = proposeOrderMeetupAction.mock.calls[0] as [unknown, FormData];
    expect(fd.get("locationSource")).toBe("CUSTOM");
    expect(fd.get("locationText")).toBe("东门快递柜旁");
    expect(fd.get("meetupPointId")).toBeNull();
  });
});
