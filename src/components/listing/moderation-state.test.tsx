import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  ModerationHiddenBanner,
  ModerationPendingBadge,
} from "./moderation-state";

afterEach(cleanup);

describe("Phase 7C moderation-state 组件（FR-03 安全文案合同）", () => {
  it("ModerationPendingBadge：呈现治理处理中文案，不含 moderator/note/reporter", () => {
    render(<ModerationPendingBadge />);
    expect(screen.getByTestId("moderation-pending-badge").textContent).toBe(
      "治理处理中 · 对其他用户隐藏",
    );
    expect(screen.getByTestId("moderation-pending-badge").textContent).not.toContain("审核员");
    expect(screen.getByTestId("moderation-pending-badge").textContent).not.toContain("举报");
  });

  it("ModerationHiddenBanner：owner 视图安全横幅（零治理内部信息）", () => {
    render(<ModerationHiddenBanner />);
    const banner = screen.getByTestId("moderation-hidden-banner");
    expect(banner.textContent).toContain("治理处理中");
    expect(banner.textContent).toContain("不会公开展示");
    expect(banner.textContent).not.toContain("reasonCode");
    expect(banner.textContent).not.toContain("备注");
  });
});
