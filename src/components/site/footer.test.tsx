import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SiteFooter } from "@/components/site/footer";

describe("SiteFooter", () => {
  it("renders the platform summary and stack note", () => {
    render(<SiteFooter />);

    expect(screen.getByText("校园集市")).toBeTruthy();
    expect(screen.getByText("面向大学校园的二手交易与服务撮合平台")).toBeTruthy();
    expect(screen.getByText("当前版本基于本地 PostgreSQL、Prisma 与 Auth.js 凭证登录")).toBeTruthy();
  });
});
