import { describe, expect, it } from "vitest";
import {
  buildListingSearchParams,
  hrefWithQuery,
  parsePageParam,
  withSortParam,
} from "@/lib/listing-search-params";

describe("listing-search-params", () => {
  it("parses page numbers safely", () => {
    expect(parsePageParam()).toBe(1);
    expect(parsePageParam("3")).toBe(3);
    expect(parsePageParam("0")).toBe(1);
    expect(parsePageParam("-2")).toBe(1);
    expect(parsePageParam("abc")).toBe(1);
  });

  it("builds query params and omits sentinels", () => {
    const params = buildListingSearchParams([
      { key: "q", value: " 自行车 " },
      { key: "status", value: "ALL", omitWhen: "ALL" },
      { key: "sort", value: "latest", omitWhen: "latest" },
      { key: "category", value: "cat-1" },
      { key: "empty", value: "  " },
    ]);

    expect(params.toString()).toBe("q=%E8%87%AA%E8%A1%8C%E8%BD%A6&category=cat-1");
  });

  it("builds sort hrefs without repeating defaults", () => {
    const base = buildListingSearchParams([
      { key: "q", value: "desk" },
      { key: "status", value: "ACTIVE" },
    ]);

    expect(hrefWithQuery("/products", withSortParam(base, "latest"))).toBe(
      "/products?q=desk&status=ACTIVE",
    );
    expect(hrefWithQuery("/products", withSortParam(base, "price_asc"))).toBe(
      "/products?q=desk&status=ACTIVE&sort=price_asc",
    );
  });
});
