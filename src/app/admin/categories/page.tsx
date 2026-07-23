import {
  toggleErrandCategoryStatus,
  toggleProductCategoryStatus,
  toggleServiceCategoryStatus,
  upsertErrandCategory,
  upsertProductCategory,
  upsertServiceCategory,
} from "@/actions/admin";
import { requireAdmin } from "@/lib/server-auth";
import {
  getAdminCategoryList,
  getAdminErrandCategoryList,
  getAdminServiceCategoryList,
} from "@/repositories/admin-repository";

export const dynamic = "force-dynamic";

function CategorySection({
  title,
  description,
  countLabel,
  createAction,
  updateAction,
  toggleAction,
  categories,
}: {
  title: string;
  description: string;
  countLabel: string;
  createAction: (formData: FormData) => Promise<void>;
  updateAction: (formData: FormData) => Promise<void>;
  toggleAction: (formData: FormData) => Promise<void>;
  categories: Array<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    sortOrder: number;
    isActive: boolean;
    _count: Record<string, number>;
  }>;
}) {
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-slate-950">{title}</h2>
        <p className="mt-2 text-sm text-slate-600">{description}</p>
      </div>

      <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-xl font-semibold text-slate-950">新增分类</h3>
        <form
          action={createAction}
          className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1.2fr_120px_120px_auto]"
        >
          <input
            name="name"
            placeholder="分类名称"
            className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
          />
          <input
            name="slug"
            placeholder="slug"
            className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
          />
          <input
            name="description"
            placeholder="分类说明"
            className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
          />
          <input
            name="sortOrder"
            type="number"
            defaultValue={0}
            className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
          />
          <select
            name="isActive"
            defaultValue="true"
            className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
          >
            <option value="true">启用</option>
            <option value="false">停用</option>
          </select>
          <button
            type="submit"
            className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            创建分类
          </button>
        </form>
      </div>

      <div className="grid gap-4">
        {categories.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            当前还没有分类数据。
          </div>
        ) : (
          categories.map((category) => {
            const relatedCount = Object.values(category._count)[0] ?? 0;

            return (
              <article
                key={category.id}
                className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
              >
                <div className="grid gap-6 xl:grid-cols-[1fr_auto]">
                  <form
                    action={updateAction}
                    className="grid gap-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1.2fr_120px_120px_auto]"
                  >
                    <input type="hidden" name="categoryId" value={category.id} />
                    <input
                      name="name"
                      defaultValue={category.name}
                      className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                    />
                    <input
                      name="slug"
                      defaultValue={category.slug}
                      className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                    />
                    <input
                      name="description"
                      defaultValue={category.description ?? ""}
                      className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                    />
                    <input
                      name="sortOrder"
                      type="number"
                      defaultValue={category.sortOrder}
                      className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                    />
                    <select
                      name="isActive"
                      defaultValue={category.isActive ? "true" : "false"}
                      className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                    >
                      <option value="true">启用</option>
                      <option value="false">停用</option>
                    </select>
                    <button
                      type="submit"
                      className="rounded-full border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                    >
                      保存
                    </button>
                  </form>

                  <div className="flex items-center gap-4 text-sm text-slate-500">
                    <span>
                      {countLabel}：{relatedCount}
                    </span>
                    <form action={toggleAction}>
                      <input type="hidden" name="categoryId" value={category.id} />
                      <input
                        type="hidden"
                        name="isActive"
                        value={category.isActive ? "false" : "true"}
                      />
                      <button
                        type="submit"
                        className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                      >
                        {category.isActive ? "停用" : "启用"}
                      </button>
                    </form>
                  </div>
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

export default async function AdminCategoriesPage() {
  await requireAdmin();
  const [productCategories, errandCategories, serviceCategories] = await Promise.all([
    getAdminCategoryList(),
    getAdminErrandCategoryList(),
    getAdminServiceCategoryList(),
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">分类管理</h1>
        <p className="mt-2 text-sm text-slate-600">
          统一维护商品分类、任务分类和技能服务分类，发布页和列表页会直接读取这里的启用项。
        </p>
      </div>

      <div className="space-y-12">
        <CategorySection
          title="商品分类"
          description="控制商品发布页和商品广场中的分类选项。"
          countLabel="商品数"
          createAction={upsertProductCategory}
          updateAction={upsertProductCategory}
          toggleAction={toggleProductCategoryStatus}
          categories={productCategories}
        />

        <CategorySection
          title="任务分类"
          description="控制任务发布页、任务大厅和后台任务管理中的分类选项。"
          countLabel="任务数"
          createAction={upsertErrandCategory}
          updateAction={upsertErrandCategory}
          toggleAction={toggleErrandCategoryStatus}
          categories={errandCategories}
        />

        <CategorySection
          title="服务分类"
          description="控制服务发布页、服务广场和后台服务管理中的分类选项。"
          countLabel="服务数"
          createAction={upsertServiceCategory}
          updateAction={upsertServiceCategory}
          toggleAction={toggleServiceCategoryStatus}
          categories={serviceCategories}
        />
      </div>
    </div>
  );
}
