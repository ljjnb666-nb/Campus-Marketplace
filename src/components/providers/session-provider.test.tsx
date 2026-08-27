import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppSessionProvider } from "@/components/providers/session-provider";

vi.mock("next-auth/react", () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="session-provider">{children}</div>
  ),
}));

describe("AppSessionProvider", () => {
  it("wraps children with the next-auth session provider", () => {
    render(
      <AppSessionProvider>
        <span>provider child</span>
      </AppSessionProvider>,
    );

    expect(screen.getByTestId("session-provider")).toBeInTheDocument();
    expect(screen.getByText("provider child")).toBeTruthy();
  });
});
