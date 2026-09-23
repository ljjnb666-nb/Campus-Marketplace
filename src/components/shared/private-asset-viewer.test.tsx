import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.stubGlobal("fetch", fetchMock);

import { PrivateAssetViewer } from "@/components/shared/private-asset-viewer";

/**
 * RB-01 Repair 2：PrivateAssetViewer fail-closed 渲染合同。
 * 仅受控 asset:<id> 允许进入受保护查看流程；历史 /uploads/ 直链、外链、
 * 恶意/畸形串一律渲染为非交互"不可用"状态，原始值绝不进入 DOM。
 */

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function expectNoRawValue(raw: string) {
  cleanup();
  const { container } = render(<PrivateAssetViewer value={raw} label="查看学生证材料" />);
  expect(screen.getByText("历史认证材料不可用")).toBeTruthy();
  expect(screen.queryByText("查看学生证材料")).toBeNull();
  expect(container.querySelector("a")).toBeNull();
  expect(container.querySelector("[href]")).toBeNull();
  expect(container.innerHTML).not.toContain(raw);
}

describe("PrivateAssetViewer（RB-01 fail-closed）", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("TEST 1：受控 asset 引用渲染受保护查看按钮（点击走 /api/assets 访问接口）", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ url: "/api/assets/asset-1/content", access: "PRIVATE" }),
    });
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<PrivateAssetViewer value="asset:asset-1" label="查看学生证材料" />);

    const button = screen.getByText("查看学生证材料（已加密，点击查看）");
    expect(containerHasAnchorWith(button.ownerDocument, "asset:asset-1")).toBe(false);

    fireEvent.click(button);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/assets/asset-1/access");
    });
    expect(opened).toHaveBeenCalledWith("/api/assets/asset-1/content", "_blank", "noreferrer");
    opened.mockRestore();
  });

  it("TEST 2：历史 /uploads/ 直链不渲染链接", () => {
    expectNoRawValue("/uploads/student-card-old.jpg");
  });

  it("TEST 3：历史 https 外链不渲染链接", () => {
    expectNoRawValue("https://example.com/card.jpg");
  });

  it("TEST 4：畸形/恶意 legacy 值 fail closed（绝不渲染 href）", () => {
    expectNoRawValue("javascript:alert(1)");
    expectNoRawValue("legacy");
    expectNoRawValue("erased");
    expectNoRawValue("asset:");
    expectNoRawValue("asset:../etc/passwd");
  });
});

function containerHasAnchorWith(doc: Document, value: string): boolean {
  return Array.from(doc.querySelectorAll("a")).some((a) => a.getAttribute("href") === value);
}
