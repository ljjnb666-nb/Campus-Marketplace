import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { RestrictedAppealPortal } from "@/components/appeals/restricted-appeal-portal";

const candidate = {
  enforcementActionId: "action-self-1",
  type: "ACCOUNT_SUSPEND",
  scopeKind: "GLOBAL",
  createdAt: "2026-10-21T00:00:00.000Z",
  appeal: null,
} as const;

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("R3D02C07D02 受限申诉自助页面（只走 /api/appeals/**）", () => {
  it("匿名/不合格会话：不渲染处罚记录、不提交写入、不枚举账户状态", async () => {
    const send = vi.fn().mockResolvedValue(response(401, { error: "未登录或账号不可用" }));
    vi.stubGlobal("fetch", send);
    render(<RestrictedAppealPortal />);
    expect(await screen.findByText(/当前无法验证申诉会话/)).toBeInTheDocument();
    expect(screen.queryByText("账号限制")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "提交申诉" })).not.toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain("/api/appeals/eligible-actions?limit=25");
    expect(send.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
  });

  it("受限身份在服务端授权后的本人结果可选择申诉，POST 不携带 actor 或 target 标识", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(response(200, { items: [candidate], nextCursor: null }))
      .mockResolvedValueOnce(response(201, {
        appeal: { id: "appeal-1", enforcementActionId: candidate.enforcementActionId, status: "SUBMITTED" },
      }))
      .mockResolvedValueOnce(response(200, {
        items: [{ ...candidate, appeal: { id: "appeal-1", status: "SUBMITTED" } }], nextCursor: null,
      }));
    vi.stubGlobal("fetch", send);
    render(<RestrictedAppealPortal />);
    expect(await screen.findByText("账号限制")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "为此项处罚提交申诉" }));
    fireEvent.change(screen.getByLabelText("申诉说明"), { target: { value: " 请复核此次处理。 " } });
    fireEvent.click(screen.getByRole("button", { name: "提交申诉" }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    const [url, options] = send.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/appeals");
    expect(options).toMatchObject({
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(options.body as string)).toEqual({
      enforcementActionId: "action-self-1", statement: "请复核此次处理。",
    });
    expect(await screen.findByText(/已有申诉，状态：/)).toHaveTextContent("已提交");
    expect(screen.queryByRole("button", { name: "为此项处罚提交申诉" })).not.toBeInTheDocument();
  });

  it("已有申诉只显示有限状态，不重新开放相同处罚的提交按钮", async () => {
    const send = vi.fn().mockResolvedValue(response(200, {
      items: [{ ...candidate, appeal: { id: "appeal-existing", status: "IN_REVIEW" } }],
      nextCursor: null,
    }));
    vi.stubGlobal("fetch", send);
    render(<RestrictedAppealPortal />);
    expect(await screen.findByText(/已有申诉，状态：/)).toHaveTextContent("审核中");
    expect(screen.queryByRole("button", { name: "提交申诉" })).not.toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("异常 API 响应保持 fail closed，禁止任意字段直接渲染成授权列表", async () => {
    const send = vi.fn().mockResolvedValue(response(200, {
      items: [{ ...candidate, type: "UNEXPECTED_ADMIN_EVENT" }], nextCursor: null,
    }));
    vi.stubGlobal("fetch", send);
    render(<RestrictedAppealPortal />);
    expect(await screen.findByRole("alert")).toHaveTextContent("申诉记录暂时无法读取");
    expect(screen.queryByRole("button", { name: "提交申诉" })).not.toBeInTheDocument();
    expect(screen.queryByText("账号限制")).not.toBeInTheDocument();
  });

  it("请求失败不伪装为申诉成功，不自动重复 POST", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(response(200, { items: [candidate], nextCursor: null }))
      .mockResolvedValueOnce(response(503, { error: "不可用" }));
    vi.stubGlobal("fetch", send);
    render(<RestrictedAppealPortal />);
    await screen.findByText("账号限制");
    fireEvent.click(screen.getByRole("button", { name: "为此项处罚提交申诉" }));
    fireEvent.change(screen.getByLabelText("申诉说明"), { target: { value: "申诉理由" } });
    fireEvent.click(screen.getByRole("button", { name: "提交申诉" }));
    expect(await screen.findByText(/申诉未提交，请刷新可申诉记录后重试/)).toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
