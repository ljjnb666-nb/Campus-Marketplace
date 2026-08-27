import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { toggleRentalFavorite } = vi.hoisted(() => ({
  toggleRentalFavorite: vi.fn(),
}));

vi.mock("@/actions/rental-favorite", () => ({
  toggleRentalFavorite,
}));

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

import { RentalFavoriteButton } from "@/components/rental/rental-favorite-button";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RentalFavoriteButton", () => {
  it("links to the login page for anonymous visitors", () => {
    render(<RentalFavoriteButton rentalListingId="r1" isFavorited={false} count={3} isLoggedIn={false} />);

    const link = screen.getByRole("link", { name: /收藏/ });
    expect(link).toHaveAttribute("href", "/login");
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("submits the toggle action with the listing id when logged in", () => {
    render(<RentalFavoriteButton rentalListingId="r1" isFavorited={false} count={0} />);

    const form = screen.getByRole("button", { name: /收藏/ }).closest("form");
    expect(form).toHaveAttribute("action");
    expect(
      (form?.querySelector('input[name="rentalListingId"]') as HTMLInputElement)?.value,
    ).toBe("r1");
  });

  it("shows the favorited state", () => {
    render(<RentalFavoriteButton rentalListingId="r1" isFavorited={true} count={5} />);

    expect(screen.getByText("已收藏")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });
});
