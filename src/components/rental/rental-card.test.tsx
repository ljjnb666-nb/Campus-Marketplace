import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import { RentalCard } from "@/components/rental/rental-card";

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    id: "rental-1",
    title: "佳能相机出租",
    price: "50",
    pricingUnit: "PER_DAY" as const,
    depositAmount: "100",
    pickupLocation: "东门快递点",
    status: "AVAILABLE" as const,
    imageUrl: "https://example.com/camera.jpg",
    ownerName: "张同学",
    ownerVerified: true,
    favoriteCount: 5,
    categoryName: "数码设备",
    ...overrides,
  };
}

afterEach(cleanup);

describe("RentalCard", () => {
  it("renders the listing summary with price unit and deposit", () => {
    render(<RentalCard {...baseProps()} />);

    expect(screen.getByText("佳能相机出租")).toBeInTheDocument();
    expect(screen.getByText("数码设备")).toBeInTheDocument();
    expect(screen.getByText("押金 ¥100")).toBeInTheDocument();
    expect(screen.getByText("张同学")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "佳能相机出租" })).toHaveAttribute(
      "src",
      "https://example.com/camera.jpg",
    );
  });

  it("highlights free-deposit listings instead of showing a deposit", () => {
    render(<RentalCard {...baseProps({ depositAmount: "0" })} />);

    expect(screen.getByText("免押金")).toBeInTheDocument();
    expect(screen.queryByText(/^押金/)).not.toBeInTheDocument();
  });

  it("shows a placeholder when there is no cover image", () => {
    render(<RentalCard {...baseProps({ imageUrl: undefined })} />);

    expect(screen.getByText("无物品图片")).toBeInTheDocument();
  });
});
