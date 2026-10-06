import { Prisma } from "@prisma/client";

/**
 * 软删除统一拦截（Prisma client extension）。
 *
 * 带 deletedAt 的模型（User/Product/ErrandTask/ServiceListing/RentalListing）在
 * 顶层查询中自动注入 `deletedAt: null` 过滤，业务代码不再需要逐查询手写，
 * 消除"某条查询忘记过滤已删除数据"这类遗漏。
 *
 * 显式豁免规则（仅 read side）：若 where 顶层或 AND/OR/NOT 分支中已显式声明
 * deletedAt（例如管理端列出已删除数据、检查软删除可见性），则视为调用方自行
 * 管理软删除可见性，读取注入不做任何改写。
 *
 * ============================================================
 * Mutation contract（PRISMA-SOFT-DELETE-IMPL-01，fail closed）
 * ============================================================
 * 软删除是显式的 domain lifecycle mutation，不是数据库通用操作：
 *   Product/ServiceListing/RentalListing → status=OFFLINE + deletedAt=now()
 *   ErrandTask → status=CANCELLED + accepterId=null + deletedAt=now()
 *
 * 权威 mutation owner 是 canonical domain lifecycle services：
 *   deleteProductListingTx / deleteServiceListingTx / deleteRentalListingTx
 *   （src/lib/listings/listing-lifecycle-service.ts）
 *   deleteErrandTx（src/lib/errand-lifecycle.ts）
 * 它们在同一事务内完成 lock → authority predicates → active obligation 检查
 * → 状态归一化 → deletedAt，不能被通用 delete 语义替代。
 *
 * 因此经扩展业务客户端对软删除模型调用 delete/deleteMany 一律 fail closed：
 *   - 不再做 delete → update / deleteMany → updateMany 透明改写（query 组件
 *     无公开操作改写 API，改写须经 defineExtension 闭包捕获的 root client，
 *     在 interactive transaction 内会以 autocommit 逃逸事务）；
 *   - 即使 where 显式包含 deletedAt 也拒绝（豁免路径会被 dynamic alias +
 *     deletedAt predicate 组合绕过 ownership guard，PRISMA-SOFT-DELETE-ARCH-01
 *     / Controller 修正）。
 *   物理清理不属于业务扩展客户端（当前生产 PHYSICAL_PURGE_CALLERS = 0）；
 *   测试基建的裸 PrismaClient 清理不走本 extension；未来生产 purge 由
 *   SOFT_DELETE_PURGE_01 以 dedicated raw/base client 单独设计。
 *
 * 非软删除模型的 delete/deleteMany 保持 query(args) 原生硬删除透传：query
 * 绑定当前查询执行上下文，在 interactive transaction 内即事务客户端（
 * CI-FLAKE-01 修复，TX-ESCAPE-01/02 门禁覆盖），绝不经 root client delegate。
 *
 * 已知边界（均与改造前行为一致，无回退）：
 * - include 嵌套关联读取（如 product.include.owner）不被拦截；
 * - 单行 update 不注入 deletedAt 过滤（unique where 无法注入），软删除行的
 *   更新防护由 domain lifecycle services 的前置谓词承担。
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

/** 软删除模型隐式删除拒绝的稳定错误码（运行时 fail-closed 合同） */
export const SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED =
  "SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED";

/**
 * 经扩展业务客户端对软删除模型调用 delete/deleteMany 时抛出。
 * 软删除必须走对应 domain lifecycle mutation（带权威谓词与状态归一化）。
 */
export class SoftDeleteExplicitDomainMutationRequiredError extends Error {
  readonly code = SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED;

  constructor(model: string, operation: "delete" | "deleteMany") {
    super(
      `${SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED}: 软删除模型 ${model} 禁止通过 ` +
        `Prisma ${operation} 修改；请调用对应 domain lifecycle mutation（` +
        `deleteProductListingTx / deleteServiceListingTx / deleteRentalListingTx / deleteErrandTx）`,
    );
    this.name = "SoftDeleteExplicitDomainMutationRequiredError";
  }
}

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

/**
 * 软删除模型 delete/deleteMany 的统一 fail-closed 边界。
 * 软删除的权威入口是 domain lifecycle services；此处拒绝一切隐式删除路径。
 */
function failClosed(model: string | undefined, operation: "delete" | "deleteMany"): never {
  throw new SoftDeleteExplicitDomainMutationRequiredError(model ?? "", operation);
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

        // 软删除模型：一律 fail closed（含显式 deletedAt 条件——不保留物理豁免 bypass，
        // dynamic alias + deletedAt predicate 不能绕过 ownership guard）。
        // 非软删除模型：query(args) 原生硬删除透传，事务上下文得以保留（CI-FLAKE-01）。
        delete: async ({ model, args, query }) => {
          if (isSoftDeleteModel(model)) {
            failClosed(model, "delete");
          }

          return query(args);
        },
        deleteMany: async ({ model, args, query }) => {
          if (isSoftDeleteModel(model)) {
            failClosed(model, "deleteMany");
          }

          return query(args);
        },
      },
    },
  }),
);
