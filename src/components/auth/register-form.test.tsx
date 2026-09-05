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
    const view = render(
      <RegisterForm
        campuses={[
          { id: "campus-1", name: "主校区", schoolName: "示例大学" },
          { id: "campus-2", name: "南校区", schoolName: "另一所大学" },
        ]}
        requiredDocuments={[
          { id: "doc-terms", slug: "terms", title: "校园集市用户服务协议", version: 1 },
          { id: "doc-privacy", slug: "privacy", title: "校园集市隐私政策", version: 1 },
        ]}
      />,
    );

    const schoolInput = screen.getByDisplayValue("示例大学") as HTMLInputElement;
    const campusSelect = screen.getByDisplayValue("示例大学 · 主校区");

    expect(schoolInput.getAttribute("readonly")).not.toBeNull();

    fireEvent.change(campusSelect, { target: { value: "campus-2" } });

    expect(screen.getByDisplayValue("另一所大学")).toBeTruthy();
    view.unmount();
  });

  it("requires an explicit legal acceptance checkbox and carries current document ids", () => {
    render(
      <RegisterForm
        campuses={[{ id: "campus-1", name: "主校区", schoolName: "示例大学" }]}
        requiredDocuments={[
          { id: "doc-terms", slug: "terms", title: "校园集市用户服务协议", version: 1 },
        ]}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: /我已阅读并同意上述全部协议/ }) as HTMLInputElement;
    expect(checkbox.required).toBe(true);

    // 当前 required 文档 id 以 hidden 字段随表单提交，服务端会与
    // 当前 required 集合做一致性校验（fail closed）
    const hiddenInputs = document.querySelectorAll('input[name="acceptedDocumentIds"]');
    expect(hiddenInputs).toHaveLength(1);
    expect((hiddenInputs[0] as HTMLInputElement).value).toBe("doc-terms");
  });
});
