import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireUser,
  getMyPublishedErrands,
  getMyAcceptedErrands,
  deleteErrand,
} = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getMyPublishedErrands: vi.fn(),
  getMyAcceptedErrands: vi.fn(),
  deleteErrand: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/errand-repository", () => ({
  getMyPublishedErrands,
  getMyAcceptedErrands,
}));

vi.mock("@/actions/errand", () => ({
  deleteErrand,
}));

import MyErrandsPage from "@/app/my/errands/page";

afterEach(() => {
  cleanup();
});

describe("MyErrandsPage", () => {
  it("renders empty states for published and accepted errands", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getMyPublishedErrands.mockResolvedValue([]);
    getMyAcceptedErrands.mockResolvedValue([]);

    render(await MyErrandsPage());

    expect(screen.getByRole("heading", { name: "我的任务" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "发布任务" }).getAttribute("href")).toBe(
      "/errands/new",
    );
    expect(screen.getByText("你还没有发布任务。")).toBeTruthy();
    expect(screen.getByText("你还没有接单任务。")).toBeTruthy();
  });

  it("renders published and accepted errands with actions", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getMyPublishedErrands.mockResolvedValue([
      {
        id: "errand-1",
        title: "代取快递",
        pickupLocation: "快递站",
        deliveryLocation: "宿舍楼",
        reward: 8,
        status: "OPEN",
        accepter: null,
      },
    ]);
    getMyAcceptedErrands.mockResolvedValue([
      {
        id: "errand-2",
        title: "代打打印",
        pickupLocation: "图书馆",
        deliveryLocation: "教学楼",
        reward: 4,
        status: "IN_PROGRESS",
        publisher: { name: "李同学" },
      },
    ]);

    render(await MyErrandsPage());

    expect(screen.getByText("代取快递")).toBeTruthy();
    expect(screen.getByText("暂无接单人")).toBeTruthy();
    expect(screen.getByText("¥8")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "查看详情" })[0]?.getAttribute("href")).toBe(
      "/errands/errand-1",
    );
    expect(screen.getByRole("link", { name: "编辑" }).getAttribute("href")).toBe(
      "/errands/errand-1/edit",
    );
    expect(screen.getByDisplayValue("errand-1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
    expect(screen.getByText("代打打印")).toBeTruthy();
    expect(screen.getByText("李同学")).toBeTruthy();
    expect(screen.getByText("¥4")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "查看详情" })[1]?.getAttribute("href")).toBe(
      "/errands/errand-2",
    );
  });
});
