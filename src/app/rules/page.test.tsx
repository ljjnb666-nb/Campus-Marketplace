import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RulesPage from "@/app/rules/page";

describe("RulesPage", () => {
  it("renders the platform rules content", () => {
    render(<RulesPage />);

    expect(screen.getByRole("heading", { name: "平台规则" })).toBeTruthy();
    expect(
      screen.getByText(/禁止内容包括：代写作业、代考、论文代写、违禁品交易、账号买卖/),
    ).toBeTruthy();
    expect(
      screen.getByText(/允许的学习类服务包括：课程辅导、题目讲解、编程答疑、作业批改、PPT/),
    ).toBeTruthy();
  });
});
