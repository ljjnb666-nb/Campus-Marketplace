import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";

const { enforcementActionFindMany, appealFindUnique } = vi.hoisted(() => ({
  enforcementActionFindMany: vi.fn(),
  appealFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    enforcementAction: {
      findMany: enforcementActionFindMany,
    },
    appeal: {
      findUnique: appealFindUnique,
    },
  },
}));

import {
  listEligibleAppealActions,
  loadAppellantAppealSelfDto,
} from "@/lib/appeals/appeal-query";
import { decodeAppealCursor, encodeAppealCursor } from "@/validators/appeal";

type FindManyArgs = Prisma.EnforcementActionFindManyArgs;

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ea-1",
    type: "ACCOUNT_SUSPEND",
    campusId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    appeal: null,
    ...overrides,
  };
}

beforeEach(() => {
  enforcementActionFindMany.mockReset();
  appealFindUnique.mockReset();
});

describe("listEligibleAppealActions（keyset 分页合同）", () => {
  it("applies the frozen base query: self-owned punitive types only", async () => {
    enforcementActionFindMany.mockResolvedValue([]);

    await listEligibleAppealActions({ targetUserId: "user-1", limit: 25 });

    const args = enforcementActionFindMany.mock.calls[0][0] as FindManyArgs;
    expect(args.where).toMatchObject({
      targetId: "user-1",
      type: {
        in: ["ACCOUNT_SUSPEND", "MEMBERSHIP_SUSPEND", "MARKETPLACE_RESTRICT"],
      },
    });
    // 无 cursor 时不带 keyset 条件
    expect("OR" in (args.where ?? {})).toBe(false);
  });

  it("uses the stable total order createdAt DESC, id DESC", async () => {
    enforcementActionFindMany.mockResolvedValue([]);

    await listEligibleAppealActions({ targetUserId: "user-1", limit: 25 });

    const args = enforcementActionFindMany.mock.calls[0][0] as FindManyArgs;
    expect(args.orderBy).toEqual([
      { createdAt: "desc" },
      { id: "desc" },
    ]);
  });

  it("translates a cursor into the keyset condition (lt OR (equals AND id lt))", async () => {
    enforcementActionFindMany.mockResolvedValue([]);
    const cursor = { createdAt: new Date("2026-01-01T00:00:00.000Z"), id: "ea-50" };

    await listEligibleAppealActions({ targetUserId: "user-1", cursor, limit: 25 });

    const args = enforcementActionFindMany.mock.calls[0][0] as FindManyArgs;
    expect(args.where && "OR" in args.where && args.where.OR).toEqual([
      { createdAt: { lt: cursor.createdAt } },
      {
        AND: [
          { createdAt: { equals: cursor.createdAt } },
          { id: { lt: cursor.id } },
        ],
      },
    ]);
  });

  it("fetches limit+1, drops the extra row, and derives nextCursor from the last returned item", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const rows = Array.from({ length: 26 }, (_, i) =>
      row({ id: `ea-${i}`, createdAt }),
    );
    enforcementActionFindMany.mockImplementation(async (args: FindManyArgs) => {
      expect(args.take).toBe(26); // limit 25 + 1
      return rows;
    });

    const page = await listEligibleAppealActions({ targetUserId: "user-1", limit: 25 });

    expect(page.items).toHaveLength(25);
    expect(page.nextCursor).not.toBeNull();
    // nextCursor 来自实际返回的最后一条（第 25 条），而不是被丢弃的探针行
    const decoded = decodeAppealCursor(page.nextCursor as string);
    expect(decoded).toEqual({ createdAt, id: "ea-24" });
  });

  it("returns nextCursor = null on the final page (DISCOVERY-6)", async () => {
    enforcementActionFindMany.mockResolvedValue([row({ id: "ea-0" })]);

    const page = await listEligibleAppealActions({ targetUserId: "user-1", limit: 25 });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("maps rows to the frozen DTO（scopeKind/createdAt/appeal），不携带任何禁字段", async () => {
    enforcementActionFindMany.mockResolvedValue([
      row({
        id: "ea-global",
        campusId: null,
        appeal: { id: "ap-1", status: "SUBMITTED" },
      }),
      row({
        id: "ea-campus",
        type: "MEMBERSHIP_SUSPEND",
        campusId: "campus-1",
        createdAt: new Date("2025-12-31T10:00:00.000Z"),
      }),
    ]);

    const page = await listEligibleAppealActions({ targetUserId: "user-1", limit: 25 });

    expect(page.items).toEqual([
      {
        enforcementActionId: "ea-global",
        type: "ACCOUNT_SUSPEND",
        scopeKind: "GLOBAL",
        createdAt: "2026-01-01T00:00:00.000Z",
        appeal: { id: "ap-1", status: "SUBMITTED" },
      },
      {
        enforcementActionId: "ea-campus",
        type: "MEMBERSHIP_SUSPEND",
        scopeKind: "CAMPUS",
        createdAt: "2025-12-31T10:00:00.000Z",
        appeal: null,
      },
    ]);
    const raw = JSON.stringify(page.items);
    for (const forbidden of [
      "reasonCode", "actorId", "sourceType", "sourceId", "previousState",
      "resultState", "enforcementSeq", "note", "reviewedById", "decisionNote",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});

describe("cursor 编解码（validators/appeal）", () => {
  it("round-trips (createdAt, id)", () => {
    const cursor = { createdAt: new Date("2026-06-01T12:34:56.789Z"), id: "ea-abc" };
    const decoded = decodeAppealCursor(encodeAppealCursor(cursor));
    expect(decoded).toEqual(cursor);
  });

  it("rejects malformed base64url / JSON / schema (DISCOVERY-5A)", () => {
    expect(decodeAppealCursor("not-base64url!!")).toBeNull();
    expect(decodeAppealCursor(Buffer.from("{broken", "utf8").toString("base64url"))).toBeNull();
    expect(
      decodeAppealCursor(Buffer.from(JSON.stringify({ id: "ea-1" }), "utf8").toString("base64url")),
    ).toBeNull();
    expect(
      decodeAppealCursor(
        Buffer.from(JSON.stringify({ createdAt: "nope", id: "ea-1" }), "utf8").toString("base64url"),
      ),
    ).toBeNull();
    // 未知字段 → strict 拒绝
    expect(
      decodeAppealCursor(
        Buffer.from(
          JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", id: "ea-1", targetId: "other" }),
          "utf8",
        ).toString("base64url"),
      ),
    ).toBeNull();
  });
});

describe("loadAppellantAppealSelfDto（6C-1B 冻结 self DTO）", () => {
  it("selects exactly the appellant DTO fields and serializes dates", async () => {
    appealFindUnique.mockResolvedValue({
      id: "ap-1",
      enforcementActionId: "ea-1",
      status: "SUBMITTED",
      statement: "说明",
      decisionReasonCode: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      reviewedAt: null,
    });

    const dto = await loadAppellantAppealSelfDto("ap-1");

    expect(dto).toEqual({
      id: "ap-1",
      enforcementActionId: "ea-1",
      status: "SUBMITTED",
      statement: "说明",
      decisionReasonCode: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      reviewedAt: null,
    });
    const args = appealFindUnique.mock.calls[0][0];
    expect(Object.keys(args.select)).toEqual([
      "id", "enforcementActionId", "status", "statement",
      "decisionReasonCode", "createdAt", "updatedAt", "reviewedAt",
    ]);
  });

  it("returns null when the appeal row is missing", async () => {
    appealFindUnique.mockResolvedValue(null);
    await expect(loadAppellantAppealSelfDto("missing")).resolves.toBeNull();
  });
});
