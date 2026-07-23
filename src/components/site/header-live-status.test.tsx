import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeaderLiveStatus } from "@/components/site/header-live-status";

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

describe("HeaderLiveStatus", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders initial unread badges", () => {
    render(<HeaderLiveStatus initialMessageCount={2} initialNotificationCount={5} />);

    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
  });

  it("polls live summary and refreshes badge counts", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        unreadNotifications: 101,
        unreadConversations: 7,
      }),
    } as Response);

    vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      if (typeof handler === "function") {
        void handler();
      }
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});

    render(<HeaderLiveStatus initialMessageCount={0} initialNotificationCount={0} />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/user/live-summary", {
        method: "GET",
        cache: "no-store",
      });
    });

    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("99+")).toBeTruthy();
  });
});
