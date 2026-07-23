import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RegisterForm } from "@/components/auth/register-form";

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

vi.mock("@/actions/auth", () => ({
  registerUser: vi.fn(),
}));

describe("RegisterForm", () => {
  it("syncs the school field with the selected campus", () => {
    render(
      <RegisterForm
        campuses={[
          { id: "campus-1", name: "主校区", schoolName: "示例大学" },
          { id: "campus-2", name: "南校区", schoolName: "另一所大学" },
        ]}
      />,
    );

    const schoolInput = screen.getByDisplayValue("示例大学") as HTMLInputElement;
    const campusSelect = screen.getByDisplayValue("示例大学 · 主校区");

    expect(schoolInput.getAttribute("readonly")).not.toBeNull();

    fireEvent.change(campusSelect, { target: { value: "campus-2" } });

    expect(screen.getByDisplayValue("另一所大学")).toBeTruthy();
  });
});
