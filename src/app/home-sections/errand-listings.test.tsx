import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getHomepageErrands } = vi.hoisted(() => ({
  getHomepageErrands: vi.fn(),
}));

vi.mock("@/repositories/home-repository", () => ({
  getHomepageErrands,
}));

vi.mock("@/components/site/listing-grid", () => ({
  ListingGrid: ({
    title,
    items,
    moreHref,
  }: {
    title: string;
    items: { id: string; title: string }[];
    moreHref?: string;
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{moreHref}</p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.title}</li>
        ))}
      </ul>
    </section>
  ),
}));

import { HomeErrandListings } from "@/app/home-sections/errand-listings";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HomeErrandListings", () => {
  it("renders the two errand grids from repository data", async () => {
    getHomepageErrands.mockResolvedValue({
      urgentErrands: [{ id: "errand-1", title: "帮我取快递" }],
      highRewardErrands: [{ id: "errand-2", title: "代买晚饭" }],
    });

    render(await HomeErrandListings({ campusId: "campus-1" }));

    expect(getHomepageErrands).toHaveBeenCalledWith({ campusId: "campus-1" });
    expect(
      screen.getByRole("heading", { name: "紧急跑腿任务" }),
    ).toBeTruthy();
    expect(
      screen.getByText("/errands?deadline=today&sort=deadline_asc"),
    ).toBeTruthy();
    expect(screen.getByText("帮我取快递")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "高赏金任务" })).toBeTruthy();
    expect(screen.getByText("/errands?sort=reward_desc")).toBeTruthy();
    expect(screen.getByText("代买晚饭")).toBeTruthy();
  });
});
