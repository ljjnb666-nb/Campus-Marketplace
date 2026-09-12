import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CampusRoleGrantForm,
  RevokeRoleButton,
} from "@/components/governance/role-manage-forms";
import type { GovernanceRoleActionState } from "@/actions/governance-roles";

/**
 * Phase 7B 冻结矩阵 UI 组件测试：授予/撤回表单的客户端行为。
 * disabled/hidden 不是授权——action 层独立授权由 A 系列锁定，此处仅锁定
 * 表单提交载荷（campusId/email/assignmentId）与反馈呈现。
 */

const campuses = [
  { id: "campus-a", name: "主校区" },
  { id: "campus-b", name: "分校区" },
];

function okState(message?: string): GovernanceRoleActionState {
  return { success: true, message };
}

function denyState(): GovernanceRoleActionState {
  return { success: false, error: "没有权限执行该角色管理操作" };
}

describe("CampusRoleGrantForm", () => {
  let grantAction: ReturnType<typeof vi.fn>;
  let lookupAction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    grantAction = vi.fn();
    lookupAction = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("渲染两步表单（campus 选项 + 授予提示），零校区呈现空态", () => {
    const { rerender } = render(
      <CampusRoleGrantForm
        campuses={campuses}
        grantAction={grantAction}
        lookupAction={lookupAction}
      />,
    );

    expect(screen.getByText("第一步：查找候选用户")).toBeTruthy();
    expect(screen.getByText("第二步：确认授予")).toBeTruthy();
    expect(screen.getByText("将授予：校区申诉审核员")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "查找用户" }).length).toBe(1);
    expect(screen.getAllByRole("button", { name: "确认授予" }).length).toBe(1);

    rerender(
      <CampusRoleGrantForm
        campuses={[]}
        grantAction={grantAction}
        lookupAction={lookupAction}
      />,
    );
    expect(screen.getByText("当前没有可授予新角色的校区。")).toBeTruthy();
  });

  it("lookup 提交载荷仅含 campusId/email；命中呈现 displayName", async () => {
    lookupAction.mockResolvedValue({ success: true, displayName: "张三" });

    render(
      <CampusRoleGrantForm
        campuses={campuses}
        grantAction={grantAction}
        lookupAction={lookupAction}
      />,
    );

    const lookupForm = screen
      .getByRole("button", { name: "查找用户" })
      .closest("form") as HTMLFormElement;
    fireEvent.change(screen.getAllByRole("combobox")[0]!, {
      target: { value: "campus-a" },
    });
    fireEvent.change(screen.getAllByRole("textbox")[0]!, {
      target: { value: "user@campus.edu" },
    });
    fireEvent.submit(lookupForm);

    await waitFor(() => {
      expect(lookupAction).toHaveBeenCalledTimes(1);
    });
    const fd = lookupAction.mock.calls[0]![0] as FormData;
    expect(fd.get("campusId")).toBe("campus-a");
    expect(fd.get("email")).toBe("user@campus.edu");
    expect(await screen.findByText("找到用户：张三")).toBeTruthy();
  });

  it("grant 成功/拒绝反馈分别呈现", async () => {
    grantAction.mockResolvedValue(okState("已授予校区申诉审核员角色"));

    render(
      <CampusRoleGrantForm
        campuses={campuses}
        grantAction={grantAction}
        lookupAction={lookupAction}
      />,
    );

    const grantForm = screen
      .getByRole("button", { name: "确认授予" })
      .closest("form") as HTMLFormElement;
    fireEvent.submit(grantForm);

    expect(await screen.findByText("已授予校区申诉审核员角色")).toBeTruthy();

    cleanup();
    grantAction.mockResolvedValue(denyState());
    render(
      <CampusRoleGrantForm
        campuses={campuses}
        grantAction={grantAction}
        lookupAction={lookupAction}
      />,
    );
    fireEvent.submit(
      screen.getByRole("button", { name: "确认授予" }).closest("form") as HTMLFormElement,
    );
    expect(
      await screen.findByText("没有权限执行该角色管理操作"),
    ).toBeTruthy();
  });
});

describe("RevokeRoleButton", () => {
  afterEach(() => {
    cleanup();
  });

  it("提交载荷恰为 assignmentId；成功反馈呈现", async () => {
    const revokeAction = vi.fn().mockResolvedValue(okState("已撤回该角色授予"));

    render(<RevokeRoleButton action={revokeAction} assignmentId="asg-1" />);

    fireEvent.submit(
      screen.getByRole("button", { name: "撤回" }).closest("form") as HTMLFormElement,
    );

    await waitFor(() => {
      expect(revokeAction).toHaveBeenCalledTimes(1);
    });
    const fd = revokeAction.mock.calls[0]![0] as FormData;
    expect(fd.get("assignmentId")).toBe("asg-1");
    expect(await screen.findByText("已撤回该角色授予")).toBeTruthy();
  });

  it("拒绝反馈呈现统一文案", async () => {
    const revokeAction = vi.fn().mockResolvedValue(denyState());

    render(<RevokeRoleButton action={revokeAction} assignmentId="asg-1" />);

    fireEvent.submit(
      screen.getByRole("button", { name: "撤回" }).closest("form") as HTMLFormElement,
    );

    expect(
      await screen.findByText("没有权限执行该角色管理操作"),
    ).toBeTruthy();
  });
});
