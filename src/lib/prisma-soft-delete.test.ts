import { describe, expect, it, vi } from "vitest";

import {
  SOFT_DELETE_MODEL_NAMES,
  buildFilteredListArgs,
  buildSoftDeleteUpdateArgs,
  explicitlyFiltersDeleted,
  findUniqueResultHiddenBySoftDelete,
  softDeleteExtension,
} from "@/lib/prisma-soft-delete";

describe("SOFT_DELETE_MODEL_NAMES", () => {
  it("covers exactly the five models carrying deletedAt", () => {
    expect(SOFT_DELETE_MODEL_NAMES.sort()).toEqual([
      "ErrandTask",
      "Product",
      "RentalListing",
      "ServiceListing",
      "User",
    ]);
  });
});

describe("explicitlyFiltersDeleted", () => {
  it("detects top-level deletedAt declarations", () => {
    expect(explicitlyFiltersDeleted({ deletedAt: null })).toBe(true);
    expect(explicitlyFiltersDeleted({ deletedAt: { not: null } })).toBe(true);
  });

  it("detects deletedAt inside AND/OR/NOT branches", () => {
    expect(explicitlyFiltersDeleted({ AND: [{ status: "ACTIVE" }, { deletedAt: null }] })).toBe(true);
    expect(explicitlyFiltersDeleted({ OR: [{ deletedAt: { not: null } }] })).toBe(true);
    expect(explicitlyFiltersDeleted({ NOT: { deletedAt: null } })).toBe(true);
  });

  it("returns false for queries without an explicit deletedAt", () => {
    expect(explicitlyFiltersDeleted(undefined)).toBe(false);
    expect(explicitlyFiltersDeleted({})).toBe(false);
    expect(explicitlyFiltersDeleted({ status: "ACTIVE" })).toBe(false);
    expect(explicitlyFiltersDeleted({ OR: [{ status: "OPEN" }] })).toBe(false);
  });
});

describe("buildFilteredListArgs", () => {
  it("injects deletedAt: null for soft-delete models", () => {
    expect(
      buildFilteredListArgs("Product", { where: { status: "AVAILABLE" }, take: 10 }),
    ).toEqual({
      where: { status: "AVAILABLE", deletedAt: null },
      take: 10,
    });
  });

  it("injects even when args have no where clause yet", () => {
    expect(buildFilteredListArgs("User", undefined)).toEqual({
      where: { deletedAt: null },
    });
    expect(buildFilteredListArgs("User", {})).toEqual({
      where: { deletedAt: null },
    });
  });

  it("passes through non soft-delete models untouched (same reference)", () => {
    const args = { where: { status: "PAID" } };

    expect(buildFilteredListArgs("Order", args)).toBe(args);
  });

  it("respects explicit deletedAt intent (same reference)", () => {
    const args = { where: { deletedAt: { not: null } } };

    expect(buildFilteredListArgs("Product", args)).toBe(args);
  });
});

describe("findUniqueResultHiddenBySoftDelete", () => {
  it("reports soft-deleted rows as hidden for soft-delete models", () => {
    expect(
      findUniqueResultHiddenBySoftDelete("User", { id: "u1", deletedAt: new Date() }),
    ).toBe(true);
  });

  it("keeps live rows, null results and other models visible", () => {
    expect(findUniqueResultHiddenBySoftDelete("User", { id: "u1", deletedAt: null })).toBe(false);
    expect(findUniqueResultHiddenBySoftDelete("User", null)).toBe(false);
    expect(findUniqueResultHiddenBySoftDelete("Order", { id: "o1" })).toBe(false);
  });
});

describe("buildSoftDeleteUpdateArgs", () => {
  it("rewrites delete into a soft-delete update with a fresh timestamp", () => {
    const result = buildSoftDeleteUpdateArgs("Product", { where: { ownerId: "u1" } });

    expect(result).toEqual({
      where: { ownerId: "u1", deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it("returns null to keep the native hard delete when deletedAt is targeted", () => {
    const args = { where: { deletedAt: { not: null } } };

    expect(buildSoftDeleteUpdateArgs("Product", args)).toBeNull();
  });

  it("returns null for non soft-delete models", () => {
    expect(buildSoftDeleteUpdateArgs("Order", { where: { buyerId: "u1" } })).toBeNull();
  });
});

describe("softDeleteExtension 挂载与查询拦截", () => {
  type Handlers = Record<string, (params: Record<string, unknown>) => unknown>;

  /**
   * 应用扩展并捕获 $allModels 处理器。额外字段（如各模型委托）保留在
   * 客户端上——delete 处理器正是通过闭包引用该客户端解析委托的。
   */
  function captureHandlers(extraClient: Record<string, unknown> = {}) {
    let captured: Handlers | undefined;
    const client = {
      ...extraClient,
      $extends: (config: { query: { $allModels: Handlers } }) => {
        captured = config.query.$allModels;
        return { extended: true };
      },
    };

    softDeleteExtension(client as never);

    return () => {
      if (!captured) {
        throw new Error("扩展未成功挂载");
      }
      return captured;
    };
  }

  function makeQuery<T>(resolved: T) {
    return vi.fn().mockResolvedValue(resolved);
  }

  it("attaches via client.$extends and registers all intercepted operations", () => {
    const handlers = captureHandlers()();

    expect(Object.keys(handlers).sort()).toEqual([
      "aggregate",
      "count",
      "delete",
      "deleteMany",
      "findFirst",
      "findFirstOrThrow",
      "findMany",
      "findUnique",
      "findUniqueOrThrow",
      "groupBy",
      "updateMany",
    ]);
  });

  it.each(["findMany", "findFirst", "findFirstOrThrow", "count", "aggregate", "groupBy"])(
    "%s injects deletedAt: null for soft-delete models",
    async (operation) => {
      const handlers = captureHandlers()();
      const rows = operation === "count" ? 7 : [];
      const query = makeQuery(rows);

      await expect(
        handlers[operation]({
          model: "Product",
          args: { where: { status: "AVAILABLE" }, take: 5 },
          query,
        }),
      ).resolves.toBe(rows);

      expect(query).toHaveBeenCalledWith({
        where: { status: "AVAILABLE", deletedAt: null },
        take: 5,
      });
    },
  );

  it("updateMany injects filtering and leaves other models untouched", async () => {
    const handlers = captureHandlers()();

    const queryProduct = makeQuery({ count: 1 });
    await handlers.updateMany({
      model: "RentalListing",
      args: { where: { ownerId: "u1" }, data: { status: "OFFLINE" } },
      query: queryProduct,
    });
    expect(queryProduct).toHaveBeenCalledWith({
      where: { ownerId: "u1", deletedAt: null },
      data: { status: "OFFLINE" },
    });

    const queryOrder = makeQuery({ count: 2 });
    await handlers.updateMany({
      model: "Order",
      args: { where: { buyerId: "u1" }, data: { status: "PAID" } },
      query: queryOrder,
    });
    expect(queryOrder).toHaveBeenCalledWith({
      where: { buyerId: "u1" },
      data: { status: "PAID" },
    });
  });

  it("findUnique hides soft-deleted rows and passes live rows through", async () => {
    const handlers = captureHandlers()();

    const hiddenQuery = makeQuery({ id: "p1", deletedAt: new Date() });
    await expect(
      handlers.findUnique({ model: "Product", args: { where: { id: "p1" } }, query: hiddenQuery }),
    ).resolves.toBeNull();

    const liveRow = { id: "p2", deletedAt: null };
    const liveQuery = makeQuery(liveRow);
    await expect(
      handlers.findUnique({ model: "Product", args: { where: { id: "p2" } }, query: liveQuery }),
    ).resolves.toBe(liveRow);
  });

  it("findUniqueOrThrow converts soft-deleted hits into P2025 failures", async () => {
    const handlers = captureHandlers()();

    await expect(
      handlers.findUniqueOrThrow({
        model: "User",
        args: { where: { id: "u1" } },
        query: makeQuery({ id: "u1", deletedAt: new Date() }),
      }),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("deleteMany rewrites to soft deletion via the model delegate while explicit deletedAt stays hard", async () => {
    const delegateUpdateMany = vi.fn().mockResolvedValue({ count: 3 });
    const delegateDeleteMany = vi.fn().mockResolvedValue({ count: 9 });
    const handlers = captureHandlers({
      errandTask: { updateMany: delegateUpdateMany, deleteMany: delegateDeleteMany },
    })();

    // 软删除模型：改写为 base client 的 updateMany 打标记（query 组件无法改操作类型，
    // 直接在 deleteMany 钩子里传 data 会 PrismaClientValidationError）
    await handlers.deleteMany({
      model: "ErrandTask",
      args: { where: { publisherId: "u1" } },
      query: makeQuery({ count: 0 }),
    });
    expect(delegateUpdateMany).toHaveBeenCalledWith({
      where: { publisherId: "u1", deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });

    // 显式以 deletedAt 为条件：豁免改写，query(args) 原生硬删除透传
    const hardQuery = makeQuery({ count: 9 });
    await handlers.deleteMany({
      model: "ErrandTask",
      args: { where: { deletedAt: { not: null } } },
      query: hardQuery,
    });
    expect(hardQuery).toHaveBeenCalledWith({ where: { deletedAt: { not: null } } });
    expect(delegateDeleteMany).not.toHaveBeenCalled();
  });

  it("deleteMany fails fast when a soft-delete model delegate cannot be resolved; non soft-delete models pass through", async () => {
    const handlers = captureHandlers()();

    await expect(
      handlers.deleteMany({
        model: "NonexistentModel",
        args: { where: { id: "x" } },
        query: makeQuery({ count: 0 }),
      }),
    ).resolves.toEqual({ count: 0 });

    await expect(
      handlers.deleteMany({
        model: "Product",
        args: { where: { id: "x" } },
        query: makeQuery({ count: 0 }),
      }),
    ).rejects.toThrow("软删除映射失败");
  });

  it("single delete maps onto a soft-delete update through the model delegate", async () => {
    const delegateUpdate = vi.fn().mockResolvedValue({ id: "p1", deletedAt: new Date() });
    const handlers = captureHandlers({ product: { update: delegateUpdate } })();

    await expect(
      handlers.delete({
        model: "Product",
        args: { where: { id: "p1" } },
      }),
    ).resolves.toEqual({ id: "p1", deletedAt: expect.any(Date) });

    expect(delegateUpdate).toHaveBeenCalledWith({
      where: { id: "p1", deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it("single delete falls back to native hard delete when exempted", async () => {
    const delegateDelete = vi.fn().mockResolvedValue({ id: "w1" });
    const handlers = captureHandlers({ orderItem: { update: vi.fn(), delete: delegateDelete } })();

    await expect(
      handlers.delete({
        model: "OrderItem",
        args: { where: { id: "w1" } },
      }),
    ).resolves.toEqual({ id: "w1" });

    expect(delegateDelete).toHaveBeenCalledWith({ where: { id: "w1" } });
  });

  it("fails fast when a model delegate cannot be resolved", async () => {
    const handlers = captureHandlers()();

    await expect(
      handlers.delete({
        model: "NonexistentModel",
        args: { where: { id: "x" } },
      }),
    ).rejects.toThrow("软删除映射失败");
  });
});
