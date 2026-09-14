import { describe, expect, it } from "vitest";

import type { AuthorizationContext } from "@/lib/rbac/service";
import {
  canModerateCampus,
  deriveListingModerationAccess,
  hasAnyListingModerationAccess,
} from "@/lib/moderation/listing-moderation-access";

function context(overrides: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    userId: "user-1",
    accountActive: true,
    activeCampusIds: ["campus-1"],
    grants: [],
    ...overrides,
  };
}

const GLOBAL_GRANT = {
  roleKey: "PLATFORM_ADMIN",
  scope: "GLOBAL" as const,
  campusId: null,
  permissionKeys: ["listing.moderate"],
};

const CAMPUS_GRANT_1 = {
  roleKey: "CAMPUS_CONTENT_MODERATOR",
  scope: "CAMPUS" as const,
  campusId: "campus-1",
  permissionKeys: ["listing.moderate"],
};

const CAMPUS_GRANT_2 = {
  roleKey: "CAMPUS_APPEAL_REVIEWER",
  scope: "CAMPUS" as const,
  campusId: "campus-2",
  permissionKeys: ["appeal.review"],
};

describe("Phase 7C deriveListingModerationAccess（R2 冻结语义）", () => {
  it("null / 非激活账号 → 空 access（DEFAULT_DENY）", () => {
    expect(deriveListingModerationAccess(null)).toEqual({ global: false, campusIds: [] });
    expect(
      deriveListingModerationAccess(context({ accountActive: false, grants: [GLOBAL_GRANT] })),
    ).toEqual({ global: false, campusIds: [] });
  });

  it("GLOBAL listing.moderate → global=true（不要求 membership）", () => {
    const access = deriveListingModerationAccess(context({ grants: [GLOBAL_GRANT] }));
    expect(access).toEqual({ global: true, campusIds: [] });
    expect(hasAnyListingModerationAccess(access)).toBe(true);
    expect(canModerateCampus(access, "any-campus")).toBe(true);
  });

  it("CAMPUS grant ∧ ACTIVE membership → campusIds；未激活 membership 拒", () => {
    const access = deriveListingModerationAccess(context({ grants: [CAMPUS_GRANT_1] }));
    expect(access).toEqual({ global: false, campusIds: ["campus-1"] });
    expect(canModerateCampus(access, "campus-1")).toBe(true);
    expect(canModerateCampus(access, "campus-2")).toBe(false);

    const inactive = deriveListingModerationAccess(
      context({ grants: [{ ...CAMPUS_GRANT_1 }], activeCampusIds: [] }),
    );
    expect(inactive.campusIds).toEqual([]);
    expect(hasAnyListingModerationAccess(inactive)).toBe(false);
  });

  it("无 listing.moderate 的 grant（如申诉审核员）不进入 access", () => {
    const access = deriveListingModerationAccess(context({ grants: [CAMPUS_GRANT_2] }));
    expect(access).toEqual({ global: false, campusIds: [] });
  });

  it("GLOBAL 与 CAMPUS 并存 → union 且 campusIds 去重", () => {
    const access = deriveListingModerationAccess(
      context({ grants: [GLOBAL_GRANT, CAMPUS_GRANT_1, CAMPUS_GRANT_1] }),
    );
    expect(access).toEqual({ global: true, campusIds: ["campus-1"] });
  });
});
