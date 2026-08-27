import { Prisma } from "@prisma/client";

/**
 * 软删除统一拦截（Prisma client extension）。
 *
 * 带 deletedAt 的模型（User/Product/ErrandTask/ServiceListing/RentalListing）在
 * 顶层查询中自动注入 `deletedAt: null` 过滤，业务代码不再需要逐查询手写，
 * 消除"某条查询忘记过滤已删除数据"这类遗漏。
 *
 * 显式豁免规则：若 where 顶层或 AND/OR/NOT 分支中已显式声明 deletedAt
 * （例如管理端列出已删除数据、物理清理已删除行），则视为调用方自行管理
 * 软删除可见性，本扩展不做任何注入或改写。
 *
 * 已知边界（均与改造前行为一致，无回退）：
 * - include 嵌套关联读取（如 product.include.owner）不被拦截；
 */

const SOFT_DELETE_MODELS = new Set([
  "User",
  "Product",
  "ErrandTask",
  "ServiceListing",
  "RentalListing",
]);

/** 与数据库列名解耦的软删除模型名单，供测试快照使用 */
export const SOFT_DELETE_MODEL_NAMES = [...SOFT_DELETE_MODELS];

function isSoftDeleteModel(model: string | undefined): boolean {
  return model !== undefined && SOFT_DELETE_MODELS.has(model);
}

/** where（含 AND/OR/NOT 分支）是否已显式声明 deletedAt */
export function explicitlyFiltersDeleted(where: unknown): boolean {
  if (!where || typeof where !== "object" || Array.isArray(where)) {
    return false;
  }

  const clause = where as Record<string, unknown>;

  if ("deletedAt" in clause) {
    return true;
  }

  for (const combinator of ["AND", "OR", "NOT"] as const) {
    const nested = clause[combinator];
    if (Array.isArray(nested)) {
      if (nested.some(explicitlyFiltersDeleted)) {
        return true;
      }
    } else if (nested && typeof nested === "object") {
      if (explicitlyFiltersDeleted(nested)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 为列表型查询构造注入 deletedAt: null 后的 args。
 * 豁免场景（非软删除模型 / 已显式声明 deletedAt）原样返回。
 */
export function buildFilteredListArgs(
  model: string | undefined,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const where = readWhere(args);

  if (!isSoftDeleteModel(model) || explicitlyFiltersDeleted(where)) {
    return args;
  }

  return withWhere(args, { ...(where ?? {}), deletedAt: null });
}

/**
 * findUnique 结果后置检查：命中软删除行时按"记录不存在"处理（返回 null 由上层走 404）。
 */
export function findUniqueResultHiddenBySoftDelete(
  model: string | undefined,
  row: unknown,
): boolean {
  if (!row || typeof row !== "object") {
    return false;
  }

  return isSoftDeleteModel(model) && readDeletedAt(row) != null;
}

/**
 * 构造软删除 update 参数（delete/deleteMany 的改写目标）。
 * 豁免场景返回 null 表示仍应执行原始硬删除。
 */
export function buildSoftDeleteUpdateArgs(
  model: string | undefined,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const where = readWhere(args);

  if (!isSoftDeleteModel(model) || explicitlyFiltersDeleted(where)) {
    return null;
  }

  return {
    ...args,
    where: { ...(where ?? {}), deletedAt: null },
    data: { deletedAt: new Date() },
  };
}

function readWhere(args: Record<string, unknown> | undefined) {
  return args?.where as Record<string, unknown> | undefined;
}

function withWhere(
  args: Record<string, unknown> | undefined,
  where: Record<string, unknown>,
) {
  return { ...(args ?? {}), where };
}

function readDeletedAt(row: unknown): Date | null | undefined {
  return (row as { deletedAt?: Date | null }).deletedAt;
}

/**
 * 解析模型的委托（delete→update 改写与原生 delete 回退共用）。
 * 模型名来自 Prisma 查询组件的 PascalCase（如 "Product"），
 * 而客户端委托属性为 camelCase（client.product），此处完成转换。
 */
function resolveDelegates(
  client: unknown,
  model: string,
): {
  update?: (args: unknown) => Promise<unknown>;
  delete?: (args: unknown) => Promise<unknown>;
} {
  const delegateKey = `${model[0]?.toLowerCase() ?? ""}${model.slice(1)}`;

  return ((client as Record<string, unknown>)[delegateKey] ?? {}) as {
    update?: (args: unknown) => Promise<unknown>;
    delete?: (args: unknown) => Promise<unknown>;
  };
}

function requireDelegateOperation<T>(
  operation: T | undefined,
  model: string,
  name: string,
): T {
  if (!operation) {
    throw new Error(`软删除映射失败：模型 ${model} 缺少 ${name} 委托`);
  }

  return operation;
}

function throwAsNotFound(): never {
  throw new Prisma.PrismaClientKnownRequestError("记录已被删除（软删除拦截）", {
    code: "P2025",
    clientVersion: Prisma.prismaVersion.client,
  });
}

/**
 * 列表型查询钩子的统一入口：需要注入时改写 args（类型转换收敛于此），
 * 豁免场景原样透传以保留 Prisma 的精确返回类型推断。
 */
function filteredListQuery<A extends Record<string, unknown> | undefined, R>(
  model: string | undefined,
  args: A,
  query: (args: A) => R,
): R {
  const next = buildFilteredListArgs(model, args);

  if (next === args) {
    return query(args);
  }

  return query(next as A);
}

export const softDeleteExtension = Prisma.defineExtension((client) =>
  client.$extends({
    query: {
      $allModels: {
        // 列表型查询：统一注入 deletedAt: null
        findMany: ({ model, args, query }) =>
          filteredListQuery(model, args, query),
        findFirst: ({ model, args, query }) =>
          filteredListQuery(model, args, query),
        findFirstOrThrow: ({ model, args, query }) =>
          filteredListQuery(model, args, query),
        count: ({ model, args, query }) =>
          filteredListQuery(model, args, query),
        aggregate: ({ model, args, query }) =>
          filteredListQuery(model, args, query),
        groupBy: ({ model, args, query }) =>
          filteredListQuery(model, args, query),
        updateMany: ({ model, args, query }) =>
          filteredListQuery(model, args, query),

        // unique 查询无法往 where 注入额外字段，改为结果后置过滤
        findUnique: async ({ model, args, query }) => {
          const row = await query(args);

          return findUniqueResultHiddenBySoftDelete(model, row) ? null : row;
        },
        findUniqueOrThrow: async ({ model, args, query }) => {
          const row = await query(args);

          if (findUniqueResultHiddenBySoftDelete(model, row)) {
            throwAsNotFound();
          }

          return row;
        },

        // 删除一律降级为软删除；显式以 deletedAt 为条件时豁免（物理清理）
        deleteMany: ({ model, args, query }) => {
          const softArgs = buildSoftDeleteUpdateArgs(model, args);

          return softArgs ? query(softArgs) : query(args);
        },
        delete: async ({ model, args }) => {
          const modelName = model ?? "";
          const delegates = resolveDelegates(client, modelName);
          const softArgs = buildSoftDeleteUpdateArgs(modelName, args);

          // 软删除模型 → update 打标记；豁免场景 → 原生硬删除
          return (
            softArgs
              ? requireDelegateOperation(delegates.update, modelName, "update")(softArgs)
              : requireDelegateOperation(delegates.delete, modelName, "delete")(args)
          ) as never;
        },
      },
    },
  }),
);
