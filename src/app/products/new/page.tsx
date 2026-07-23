import Link from "next/link";
import { createProduct } from "@/actions/product";
import { ProductForm } from "@/components/product/product-form";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { getProductFormMeta } from "@/repositories/product-repository";
import { requireUser } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

export default async function NewProductPage() {
  await requireUser();
  const { categories } = await getProductFormMeta();

  return (
    <PageContainer maxWidth="form">
      <Breadcrumbs
        items={[
          { label: "二手集市", href: "/products" },
          { label: "发布商品" },
        ]}
      />

      <PageHeader
        title="发布二手闲置"
        description="准确填写闲置物品信息与当面交易位置，支持违规文本自动校验"
        className="mt-4"
        action={
          <Link
            href="/my/products"
            className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300"
          >
            我的发布历史
          </Link>
        }
      />

      <ProductForm
        action={createProduct}
        categories={categories}
        submitLabel="确认发布商品"
      />
    </PageContainer>
  );
}
