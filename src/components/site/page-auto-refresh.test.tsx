import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageAutoRefresh } from "@/components/site/page-auto-refresh";

const { mockRefresh } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mockRefresh,
  }),
}));

describe("PageAutoRefresh", () => {
  beforeEach(() => {
    mockRefresh.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes the page on the configured interval and clears the timer on unmount", () => {
    const clearSpy = vi.spyOn(window, "clearInterval");
    const { unmount } = render(<PageAutoRefresh intervalMs={15000} />);

    act(() => {
      vi.advanceTimersByTime(15000);
    });

    expect(mockRefresh).toHaveBeenCalledTimes(1);

    unmount();

    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});
