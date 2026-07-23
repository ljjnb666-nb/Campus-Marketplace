import { updateProduct } from "@/actions/product";
import { ProductForm } from "@/components/product/product-form";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { requireUser } from "@/lib/server-auth";
import { getProductForEdit, getProductFormMeta } from "@/repositories/product-repository";

export const dynamic = "force-dynamic";

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const [product, meta] = await Promise.all([getProductForEdit(id, user.id), getProductFormMeta()]);

  return (
    <PageContainer maxWidth="form">
      <Breadcrumbs
        items={[
          { label: "二手集市", href: "/products" },
          { label: product.title, href: `/products/${product.id}` },
          { label: "编辑商品" },
        ]}
      />

      <PageHeader
        title="编辑商品信息"
        description="修改商品价格、文字描述或重新调整实物图片"
        className="mt-4"
      />

      <ProductForm
        action={updateProduct}
        categories={meta.categories}
        submitLabel="保存修改"
        productId={product.id}
        defaultValues={{
          title: product.title,
          description: product.description,
          price: product.price.toString(),
          originalPrice: product.originalPrice?.toString() ?? "",
          categoryId: product.categoryId,
          condition: product.condition,
          locationText: product.locationText,
          images: product.images,
        }}
      />
    </PageContainer>
  );
}
