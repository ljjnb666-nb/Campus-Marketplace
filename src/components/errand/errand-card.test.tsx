import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrandCard } from "@/components/errand/errand-card";

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

describe("ErrandCard", () => {
  it("renders errand route, status, location, and reason", () => {
    render(
      <ErrandCard
        id="errand-1"
        title="帮取快递"
        reward="8"
        pickupLocation="东区快递站"
        deliveryLocation="3 号宿舍楼"
        publisher="陈同学"
        status="OPEN"
        reason="急单优先"
      />,
    );

    expect(screen.getByRole("link")).toHaveAttribute("href", "/errands/errand-1");
    expect(screen.getByText("待接单")).toBeTruthy();
    expect(screen.getByText("陈同学")).toBeTruthy();
    expect(screen.getByText("急单优先")).toBeTruthy();
    expect(screen.getByText(/东区快递站/)).toBeTruthy();
    expect(screen.getByText(/3 号宿舍楼/)).toBeTruthy();
    expect(screen.getByText(/8\.00/)).toBeTruthy();
  });
});
