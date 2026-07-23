import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Pagination } from "@/components/site/pagination";

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

describe("Pagination", () => {
  it("returns null when there is only one page", () => {
    const { container } = render(
      <Pagination pathname="/products" params={new URLSearchParams("keyword=book")} page={1} totalPages={1} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders previous/next links, current page, and ellipsis with preserved query params", () => {
    render(
      <Pagination
        pathname="/products"
        params={new URLSearchParams("keyword=book&sort=latest")}
        page={4}
        totalPages={7}
      />,
    );

    expect(screen.getByRole("link", { name: "上一页" })).toHaveAttribute(
      "href",
      "/products?keyword=book&sort=latest&page=3",
    );
    expect(screen.getByRole("link", { name: "下一页" })).toHaveAttribute(
      "href",
      "/products?keyword=book&sort=latest&page=5",
    );
    expect(screen.getByRole("link", { name: "4" })).toHaveAttribute(
      "href",
      "/products?keyword=book&sort=latest&page=4",
    );
    expect(screen.getAllByText("...")).toHaveLength(2);
  });
});
