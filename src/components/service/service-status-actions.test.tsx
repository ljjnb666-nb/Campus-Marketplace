import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ServiceStatusActions } from "@/components/service/service-status-actions";

vi.mock("@/actions/service", () => ({
  updateServiceStatus: vi.fn(),
}));

describe("ServiceStatusActions", () => {
  it("renders one form for each allowed next service status", () => {
    const { container } = render(
      <ServiceStatusActions serviceId="service-1" currentStatus="PAUSED" />,
    );

    expect(screen.getByRole("button", { name: "恢复接单" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "暂停接单" })).toBeNull();
    expect(screen.getByRole("button", { name: "下架服务" })).toBeTruthy();
    expect(container.querySelectorAll("form")).toHaveLength(2);
    expect(container.querySelectorAll('input[name="serviceId"][value="service-1"]')).toHaveLength(2);
    expect(container.querySelector('input[name="status"][value="ACTIVE"]')).toBeTruthy();
    expect(container.querySelector('input[name="status"][value="OFFLINE"]')).toBeTruthy();
  });
});
