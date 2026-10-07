import { describe, expect, it, vi } from "vitest";

import {
  SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED,
  SOFT_DELETE_MODEL_NAMES,
  SoftDeleteExplicitDomainMutationRequiredError,
  buildFilteredListArgs,
  buildUniqueReadPlan,
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

describe("buildUniqueReadPlan", () => {
  it("SD-READ-PLAN-01: select omitted deletedAt is injected internally without mutating caller args", () => {
    const args = { where: { id: "u1" }, select: { id: true, name: true } };
    const plan = buildUniqueReadPlan("User", args);

    expect(plan.args).toEqual({
      where: { id: "u1" },
      select: { id: true, name: true, deletedAt: true },
    });
    expect(plan.inspectDeletedAt).toBe(true);
    expect(plan.stripInjectedDeletedAt).toBe(true);
    expect(args).toEqual({ where: { id: "u1" }, select: { id: true, name: true } });
  });

  it("SD-READ-PLAN-02: explicit select false is overridden internally and restored later", () => {
    const args = { where: { id: "u1" }, select: { id: true, deletedAt: false } };
    const plan = buildUniqueReadPlan("User", args);

    expect(plan.args).toEqual({
      where: { id: "u1" },
      select: { id: true, deletedAt: true },
    });
    expect(plan.inspectDeletedAt).toBe(true);
    expect(plan.stripInjectedDeletedAt).toBe(true);
  });

  it("SD-READ-PLAN-03: omit deletedAt is temporarily overridden for internal inspection", () => {
    const args = { where: { id: "u1" }, omit: { passwordHash: true, deletedAt: true } };
    const plan = buildUniqueReadPlan("User", args);

    expect(plan.args).toEqual({
      where: { id: "u1" },
      omit: { passwordHash: true, deletedAt: false },
    });
    expect(plan.inspectDeletedAt).toBe(true);
    expect(plan.stripInjectedDeletedAt).toBe(true);
  });

  it("SD-READ-PLAN-04: explicit deletedAt where keeps caller-managed visibility", () => {
    const args = {
      where: { id: "u1", deletedAt: { not: null } },
      select: { id: true },
    };
    const plan = buildUniqueReadPlan("User", args);

    expect(plan.args).toBe(args);
    expect(plan.inspectDeletedAt).toBe(false);
    expect(plan.stripInjectedDeletedAt).toBe(false);
  });

  it("SD-READ-PLAN-05: non soft-delete models pass through untouched", () => {
    const args = { where: { id: "o1" }, select: { id: true } };
    const plan = buildUniqueReadPlan("Order", args);

    expect(plan.args).toBe(args);
    expect(plan.inspectDeletedAt).toBe(false);
    expect(plan.stripInjectedDeletedAt).toBe(false);
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

describe("softDeleteExtension 挂载与查询拦截", () => {
  type Handlers = Record<string, (params: Record<string, unknown>) => unknown>;

  /** 应用扩展并捕获 $allModels 处理器（fail-closed 后不再依赖 client 上的委托）。 */
  function captureHandlers() {
    let captured: Handlers | undefined;
    const client = {
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

  it("findUnique hides soft-deleted rows and passes live full rows through", async () => {
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

  it("SD-READ-SELECT-01: findUnique injects deletedAt for selective reads and hides deleted rows", async () => {
    const handlers = captureHandlers()();
    const query = vi.fn(async (args: Record<string, unknown>) => {
      expect(args).toEqual({
        where: { id: "p-select-deleted" },
        select: { id: true, title: true, deletedAt: true },
      });
      return { id: "p-select-deleted", title: "hidden", deletedAt: new Date() };
    });

    await expect(
      handlers.findUnique({
        model: "Product",
        args: { where: { id: "p-select-deleted" }, select: { id: true, title: true } },
        query,
      }),
    ).resolves.toBeNull();
  });

  it("SD-READ-SHAPE-01: live selective reads do not expose internally injected deletedAt", async () => {
    const handlers = captureHandlers()();
    const query = makeQuery({ id: "p-select-live", title: "visible", deletedAt: null });

    await expect(
      handlers.findUnique({
        model: "Product",
        args: { where: { id: "p-select-live" }, select: { id: true, title: true } },
        query,
      }),
    ).resolves.toEqual({ id: "p-select-live", title: "visible" });
  });

  it("SD-READ-INCLUDE-01: include/default scalar reads still hide deleted rows without shape rewrite", async () => {
    const handlers = captureHandlers()();
    const args = { where: { id: "p-include-deleted" }, include: { images: true } };
    const query = makeQuery({
      id: "p-include-deleted",
      deletedAt: new Date(),
      images: [],
    });

    await expect(
      handlers.findUnique({ model: "Product", args, query }),
    ).resolves.toBeNull();
    expect(query).toHaveBeenCalledWith(args);
  });

  it("SD-READ-OMIT-01: findUnique overrides omit internally, hides deleted rows, and preserves caller shape", async () => {
    const handlers = captureHandlers()();
    const hiddenQuery = vi.fn(async (args: Record<string, unknown>) => {
      expect(args).toEqual({
        where: { id: "u-omit-deleted" },
        omit: { passwordHash: true, deletedAt: false },
      });
      return { id: "u-omit-deleted", name: "hidden", deletedAt: new Date() };
    });

    await expect(
      handlers.findUnique({
        model: "User",
        args: {
          where: { id: "u-omit-deleted" },
          omit: { passwordHash: true, deletedAt: true },
        },
        query: hiddenQuery,
      }),
    ).resolves.toBeNull();

    const liveQuery = makeQuery({ id: "u-omit-live", name: "visible", deletedAt: null });
    await expect(
      handlers.findUnique({
        model: "User",
        args: {
          where: { id: "u-omit-live" },
          omit: { passwordHash: true, deletedAt: true },
        },
        query: liveQuery,
      }),
    ).resolves.toEqual({ id: "u-omit-live", name: "visible" });
  });

  it("SD-READ-SELECT-02: findUniqueOrThrow detects deleted rows when caller select omits deletedAt", async () => {
    const handlers = captureHandlers()();

    await expect(
      handlers.findUniqueOrThrow({
        model: "User",
        args: { where: { id: "u1" }, select: { id: true } },
        query: makeQuery({ id: "u1", deletedAt: new Date() }),
      }),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("SD-READ-EXPLICIT-01: caller-selected deletedAt remains visible on live rows", async () => {
    const handlers = captureHandlers()();
    const liveRow = { id: "u-explicit", deletedAt: null };

    await expect(
      handlers.findUnique({
        model: "User",
        args: { where: { id: "u-explicit" }, select: { id: true, deletedAt: true } },
        query: makeQuery(liveRow),
      }),
    ).resolves.toEqual(liveRow);
  });

  // ============================================================
  // SD-GUARD-U01..U06：fail-closed mutation 边界（PRISMA-SOFT-DELETE-IMPL-01）
  // ============================================================

  it("SD-GUARD-U01: Product.delete rejects with the stable error code and query is never called", async () => {
    const handlers = captureHandlers()();
    const query = makeQuery({ id: "p1", deletedAt: new Date() });

    await expect(
      handlers.delete({ model: "Product", args: { where: { id: "p1" } }, query }),
    ).rejects.toMatchObject({ code: SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED });

    // fail closed：底层 delete 查询绝不执行（不再改写为 update，也不透传）
    expect(query).not.toHaveBeenCalled();
  });

  it("SD-GUARD-U02: Product.delete with an explicit deletedAt condition still rejects", async () => {
    const handlers = captureHandlers()();
    const query = makeQuery({ id: "p1", deletedAt: new Date() });

    // 旧物理豁免 bypass 已关闭：dynamic alias + deletedAt predicate 不能绕过 ownership guard
    await expect(
      handlers.delete({
        model: "Product",
        args: { where: { id: "p1", deletedAt: { not: null } } },
        query,
      }),
    ).rejects.toMatchObject({ code: SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED });

    expect(query).not.toHaveBeenCalled();
  });

  it("SD-GUARD-U03: User.deleteMany rejects with the stable error code", async () => {
    const handlers = captureHandlers()();
    const query = makeQuery({ count: 3 });

    await expect(
      handlers.deleteMany({ model: "User", args: { where: { id: "u1" } }, query }),
    ).rejects.toMatchObject({ code: SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED });

    expect(query).not.toHaveBeenCalled();
  });

  it("SD-GUARD-U04: User.deleteMany with a deletedAt condition still rejects", async () => {
    const handlers = captureHandlers()();
    const query = makeQuery({ count: 3 });

    await expect(
      handlers.deleteMany({
        model: "User",
        args: { where: { deletedAt: { not: null } } },
        query,
      }),
    ).rejects.toMatchObject({ code: SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED });

    expect(query).not.toHaveBeenCalled();
  });

  it("SD-GUARD-U05: non soft-delete UserRoleAssignment.delete keeps query(args) hard-delete passthrough", async () => {
    // CI-FLAKE-01 回归：非软删除模型的硬删除必须经 query(args) 续传（绑定当前
    // 执行上下文——interactive transaction 内即事务客户端）。
    const handlers = captureHandlers()();
    const hardQuery = makeQuery({ id: "w1" });

    await expect(
      handlers.delete({ model: "UserRoleAssignment", args: { where: { id: "w1" } }, query: hardQuery }),
    ).resolves.toEqual({ id: "w1" });

    expect(hardQuery).toHaveBeenCalledWith({ where: { id: "w1" } });
  });

  it("SD-GUARD-U06: non soft-delete Favorite.deleteMany keeps query(args) passthrough", async () => {
    const handlers = captureHandlers()();
    const hardQuery = makeQuery({ count: 2 });

    await expect(
      handlers.deleteMany({
        model: "Favorite",
        args: { where: { userId: "u1" } },
        query: hardQuery,
      }),
    ).resolves.toEqual({ count: 2 });

    expect(hardQuery).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });

  it("fail-closed error names the owning domain lifecycle mutations", async () => {
    const handlers = captureHandlers()();

    await expect(
      handlers.delete({ model: "Product", args: { where: { id: "p1" } }, query: makeQuery({}) }),
    ).rejects.toThrow(SoftDeleteExplicitDomainMutationRequiredError);

    await expect(
      handlers.delete({ model: "Product", args: { where: { id: "p1" } }, query: makeQuery({}) }),
    ).rejects.toThrow(/deleteProductListingTx[\s\S]*deleteErrandTx/);
  });
});
