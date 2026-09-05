import { beforeEach, describe, expect, it, vi } from "vitest";

const { adminLogCreate } = vi.hoisted(() => ({
  adminLogCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    adminLog: { create: adminLogCreate },
  },
}));

import * as adminAuditModule from "@/lib/governance/admin-audit";
import { recordAdminAudit } from "@/lib/governance/admin-audit";

beforeEach(() => {
  adminLogCreate.mockReset().mockResolvedValue({});
});

describe("recordAdminAudit（append-only + metadata 白名单）", () => {
  it("writes an append-only audit row with defaults", async () => {
    await recordAdminAudit({
      actorId: "admin-1",
      action: "ROLE_ASSIGNED",
      targetType: "USER",
      targetId: "user-2",
    });

    expect(adminLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adminId: "admin-1",
        action: "ROLE_ASSIGNED",
        targetType: "USER",
        targetId: "user-2",
        result: "SUCCESS",
        campusId: null,
        detail: null,
        metadata: undefined,
      }),
    });
  });

  it("keeps only allowlisted metadata keys（白名单之外的键一律丢弃）", async () => {
    await recordAdminAudit({
      actorId: "admin-1",
      action: "APPROVE_VERIFICATION",
      targetType: "USER_VERIFICATION",
      targetId: "verification-1",
      campusId: "campus-a",
      metadata: {
        decision: "VERIFIED",
        policyVersion: 2,
        // 以下均不在白名单：必须被丢弃
        password: "secret",
        token: "jwt-value",
        studentIdFull: "2020123456789",
        objectKey: "private/verification/x.webp",
        nested: { a: 1 },
        roleNames: ["PLATFORM_ADMIN"],
      },
    });

    const call = adminLogCreate.mock.calls[0][0] as {
      data: { metadata: Record<string, unknown> };
    };
    expect(call.data.metadata).toEqual({ decision: "VERIFIED", policyVersion: 2 });
  });

  it("drops non-primitive values even for allowlisted keys", async () => {
    await recordAdminAudit({
      actorId: "admin-1",
      action: "ROLE_ASSIGNED",
      targetType: "USER",
      targetId: "user-2",
      metadata: {
        roleKey: "PLATFORM_ADMIN",
        targetUserId: ["user-2", "user-3"],
      },
    });

    const call = adminLogCreate.mock.calls[0][0] as {
      data: { metadata: Record<string, unknown> };
    };
    expect(call.data.metadata).toEqual({ roleKey: "PLATFORM_ADMIN" });
  });

  it("passes the transaction client through for atomic audit writes", async () => {
    const tx = { adminLog: { create: vi.fn().mockResolvedValue({}) } };

    await recordAdminAudit(
      {
        actorId: "admin-1",
        action: "APPROVE_VERIFICATION",
        targetType: "USER_VERIFICATION",
        targetId: "verification-1",
      },
      tx as unknown as Parameters<typeof recordAdminAudit>[1],
    );

    expect(tx.adminLog.create).toHaveBeenCalled();
    expect(adminLogCreate).not.toHaveBeenCalled();
  });

  it("does not expose any update or delete entry point（append-only 合同）", () => {
    const moduleKeys = Object.keys(adminAuditModule);
    expect(moduleKeys).toEqual(expect.arrayContaining(["recordAdminAudit"]));
    for (const key of moduleKeys) {
      expect(key.toLowerCase()).not.toContain("update");
      expect(key.toLowerCase()).not.toContain("delete");
    }
  });
});
