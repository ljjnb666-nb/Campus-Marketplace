import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button, buttonVariants } from "@/components/ui/button";

describe("Button", () => {
  it("renders the default button classes and slot attribute", () => {
    render(<Button>保存</Button>);

    const button = screen.getByRole("button", { name: "保存" });
    expect(button).toHaveAttribute("data-slot", "button");
    expect(button.className).toContain("bg-primary");
    expect(button.className).toContain("h-8");
  });

  it("applies variant and size overrides", () => {
    render(
      <Button variant="outline" size="sm">
        筛选
      </Button>,
    );

    const button = screen.getByRole("button", { name: "筛选" });
    expect(button.className).toContain("border-border");
    expect(button.className).toContain("h-7");
  });
});

describe("buttonVariants", () => {
  it("returns class names for the requested variant combination", () => {
    const className = buttonVariants({ variant: "ghost", size: "icon" });

    expect(className).toContain("hover:bg-muted");
    expect(className).toContain("size-8");
  });
});
