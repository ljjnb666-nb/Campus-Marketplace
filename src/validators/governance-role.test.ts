import { describe, expect, it } from "vitest";

import {
  GOVERNANCE_ROLE_DEFAULT_PAGE_SIZE,
  GOVERNANCE_ROLE_MAX_PAGE_SIZE,
  decodeGovernanceRoleCursor,
  encodeGovernanceRoleCursor,
  governanceRoleGrantSchema,
  governanceRoleLookupSchema,
  governanceRolePageLimitSchema,
  governanceRoleRevokeSchema,
} from "@/validators/governance-role";

/**
 * Phase 7B 冻结矩阵 U09（cursor codec + validators）。
 * Phase 7B 自有 codec——Phase 7A appeal cursor 文件零改动（Repair 5）。
 */

describe("strict validators", () => {
  it("lookup/grant 恰为 {campusId, email}；未知字段（roleKey/actorId/targetUserId）一律拒绝", () => {
    const base = { campusId: "campus-a", email: "user@campus.edu" };
    expect(governanceRoleLookupSchema.safeParse(base).success).toBe(true);
    expect(governanceRoleGrantSchema.safeParse(base).success).toBe(true);

    for (const injected of [
      { ...base, roleKey: "PLATFORM_ADMIN" },
      { ...base, actorId: "attacker" },
      { ...base, targetUserId: "victim" },
      { ...base, scopeKey: "CAMPUS:campus-a" },
      { ...base, assignedById: "attacker" },
    ]) {
      expect(governanceRoleGrantSchema.safeParse(injected).success).toBe(false);
      expect(governanceRoleLookupSchema.safeParse(injected).success).toBe(false);
    }
  });

  it("FR01-B：email 仅 trim，大小写逐字保留（不得发明 lowercase 身份键）", () => {
    const parsed = governanceRoleGrantSchema.safeParse({
      campusId: "campus-a",
      email: "  Mixed.Case@Campus.Edu  ",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.email).toBe("Mixed.Case@Campus.Edu");
    }
    expect(
      governanceRoleGrantSchema.safeParse({ campusId: "c", email: "" }).success,
    ).toBe(false);
    expect(
      governanceRoleGrantSchema.safeParse({ campusId: "c", email: "not-an-email" })
        .success,
    ).toBe(false);
  });

  it("revoke 恰为 {assignmentId}", () => {
    expect(governanceRoleRevokeSchema.safeParse({ assignmentId: "a1" }).success).toBe(
      true,
    );
    expect(
      governanceRoleRevokeSchema.safeParse({ assignmentId: "a1", email: "x@y.z" })
        .success,
    ).toBe(false);
    expect(governanceRoleRevokeSchema.safeParse({}).success).toBe(false);
  });

  it("page limit schema：缺席/越界/非整数拒绝，25/50 合法", () => {
    expect(governanceRolePageLimitSchema.safeParse("25").success).toBe(true);
    expect(governanceRolePageLimitSchema.safeParse(String(GOVERNANCE_ROLE_MAX_PAGE_SIZE)).success).toBe(true);
    expect(governanceRolePageLimitSchema.safeParse("0").success).toBe(false);
    expect(governanceRolePageLimitSchema.safeParse("51").success).toBe(false);
    expect(governanceRolePageLimitSchema.safeParse("abc").success).toBe(false);
    expect(GOVERNANCE_ROLE_DEFAULT_PAGE_SIZE).toBe(25);
    expect(GOVERNANCE_ROLE_MAX_PAGE_SIZE).toBe(50);
  });
});

// U09：cursor codec
describe("governance role cursor codec（U09）", () => {
  const at = new Date("2026-09-12T08:00:00.000Z");

  it("valid round trip（assignedAt + id）", () => {
    const encoded = encodeGovernanceRoleCursor({ assignedAt: at, id: "a1b2c3" });
    expect(decodeGovernanceRoleCursor(encoded)).toEqual({
      assignedAt: at,
      id: "a1b2c3",
    });
  });

  it("malformed → null：任意 base64 / 非 JSON / 缺 id / 非法时间戳 / 额外字段", () => {
    expect(decodeGovernanceRoleCursor("not-valid-base64!!!")).toBeNull();
    expect(
      decodeGovernanceRoleCursor(Buffer.from("not json").toString("base64url")),
    ).toBeNull();
    expect(
      decodeGovernanceRoleCursor(
        Buffer.from(JSON.stringify({ assignedAt: at.toISOString() })).toString(
          "base64url",
        ),
      ),
    ).toBeNull();
    expect(
      decodeGovernanceRoleCursor(
        Buffer.from(JSON.stringify({ assignedAt: "nope", id: "a1" })).toString(
          "base64url",
        ),
      ),
    ).toBeNull();
    expect(
      decodeGovernanceRoleCursor(
        Buffer.from(
          JSON.stringify({ assignedAt: at.toISOString(), id: "a1", extra: 1 }),
        ).toString("base64url"),
      ),
    ).toBeNull();
  });
});
