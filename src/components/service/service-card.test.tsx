import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ServiceCard } from "@/components/service/service-card";

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

describe("ServiceCard", () => {
  it("renders service meta, badges, and detail link", () => {
    render(
      <ServiceCard
        id="service-1"
        title="校园约拍"
        description="支持毕业照和社团活动跟拍"
        price="120"
        pricingUnit="PER_SESSION"
        status="ACTIVE"
        provider="王同学"
        locationText="主校区操场"
        categoryName="摄影约拍"
        coverImageUrl="/uploads/services/photo.jpg"
        completedOrderCount={9}
        reason="人气服务"
      />,
    );

    expect(screen.getByRole("link")).toHaveAttribute("href", "/services/service-1");
    expect(screen.getByAltText("校园约拍")).toHaveAttribute("src", "/uploads/services/photo.jpg");
    expect(screen.getByText("接单中")).toBeTruthy();
    expect(screen.getByText("王同学")).toBeTruthy();
    expect(screen.getByText("摄影约拍")).toBeTruthy();
    expect(screen.getByText("人气服务")).toBeTruthy();
    expect(screen.getAllByText(/120/)[0]).toBeTruthy();
    expect(screen.getByText("已接 9 单")).toBeTruthy();
  });

  it("falls back to the default remote cover image", () => {
    render(
      <ServiceCard
        id="service-2"
        title="PPT 美化"
        description="答辩 PPT 优化"
        price="50"
        pricingUnit="PER_ORDER"
        status="PAUSED"
        provider="赵同学"
        locationText="线上远程"
      />,
    );

    expect(screen.getByText("无服务展示图")).toBeTruthy();
  });
});
