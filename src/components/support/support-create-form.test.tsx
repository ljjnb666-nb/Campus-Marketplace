import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SupportCreateActionState } from "@/actions/support";
import { SupportTicketCreateForm } from "@/components/support/support-create-form";

afterEach(() => {
  cleanup();
});

function actionMock(
  impl?: (formData: FormData) => Promise<SupportCreateActionState>,
): (formData: FormData) => Promise<SupportCreateActionState> {
  return vi.fn(async (formData: FormData) =>
    impl
      ? impl(formData)
      : ({ success: true, ticketId: "t-new" } satisfies SupportCreateActionState),
  );
}

describe("SupportTicketCreateForm（用户面创建表单）", () => {
  it("有 ACTIVE membership 校区 → 渲染校区下拉；成功反馈含详情链接", async () => {
    const action = actionMock();
    render(<SupportTicketCreateForm action={action} campuses={[{ id: "A", name: "甲校区" }]} />);

    fireEvent.select(screen.getByRole("combobox", { name: /问题类型/ }), { target: { value: "SAFETY" } });
    fireEvent.select(screen.getByRole("combobox", { name: /关联校区/ }), { target: { value: "A" } });
    fireEvent.change(screen.getByRole("textbox", { name: "主题" }), { target: { value: "表单主题" } });
    fireEvent.change(screen.getByRole("textbox", { name: /问题描述/ }), {
      target: { value: "表单问题描述正文足够长。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交工单" }));

    expect(await screen.findByText(/工单已提交/)).toBeVisible();
    expect(screen.getByRole("link", { name: /查看工单详情/ })).toHaveAttribute(
      "href",
      "/support/t-new",
    );
  });

  it("无 membership 校区 → 不渲染校区下拉（提交即 UNSCOPED）", async () => {
    let captured: FormData | undefined;
    const action = vi.fn(
      async (formData: FormData): Promise<SupportCreateActionState> => {
        captured = formData;
        return { success: true };
      },
    );
    render(<SupportTicketCreateForm action={action} campuses={[]} />);

    expect(screen.queryByRole("combobox", { name: /关联校区/ })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "主题" }), { target: { value: "无校区主题" } });
    fireEvent.change(screen.getByRole("textbox", { name: /问题描述/ }), {
      target: { value: "无校区提交描述正文足够长。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交工单" }));

    expect(captured).toBeDefined();
    expect(captured!.get("campusId")).toBeNull();
  });

  it("action 失败 → role=alert 错误反馈", async () => {
    const action = vi.fn(async (): Promise<SupportCreateActionState> => ({
      success: false,
      error: "你有太多进行中的工单，请等待现有工单处理完成",
    }));
    render(<SupportTicketCreateForm action={action} campuses={[]} />);

    fireEvent.change(screen.getByRole("textbox", { name: "主题" }), { target: { value: "失败主题" } });
    fireEvent.change(screen.getByRole("textbox", { name: /问题描述/ }), {
      target: { value: "失败路径描述正文足够长。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交工单" }));

    expect(await screen.findByRole("alert")).toBeVisible();
  });
});
