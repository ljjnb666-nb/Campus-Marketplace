# 校园集市标准页面模板与结构规范 (Page Templates)

本文档规定项目各类典型页面的 DOM 结构与响应式 Layout 模板。

---

## 1. 交易广场列表页模板 (Marketplace List Template)

适用于：`/products` (二手商品), `/errands` (跑腿大厅), `/services` (技能服务), `/rentals` (租赁广场)

```tsx
<PageContainer maxWidth="wide">
  {/* 1. 统一顶栏说明 */}
  <PageHeader
    title="二手商品广场"
    description="本校学生二手闲置物品当面交易，安全省心"
    action={<PrimaryButton href="/products/new">发布闲置</PrimaryButton>}
  />

  {/* 2. 统一筛选与搜索工具栏 */}
  <FilterBar>
    <SearchInput placeholder="搜索商品名称、描述..." />
    <CategoryFilter categories={categories} />
    <SortSelect options={sortOptions} />
  </FilterBar>

  {/* 3. 响应式内容网格 */}
  {items.length === 0 ? (
    <EmptyState
      title="暂无相关商品"
      description="换个关键词搜索或成为第一个发布者吧"
      action={<PrimaryButton href="/products/new">去发布</PrimaryButton>}
    />
  ) : (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 lg:gap-6">
      {items.map(item => (
        <ProductCard key={item.id} data={item} />
      ))}
    </div>
  )}

  {/* 4. 分页器 */}
  <Pagination page={page} totalPages={totalPages} />
</PageContainer>
```

---

## 2. 核心物品/服务详情页模板 (Detail Page Template)

适用于：`/products/[id]`, `/rentals/[id]`, `/services/[id]`, `/errands/[id]`

```tsx
<PageContainer maxWidth="standard">
  {/* 1. 面包屑 */}
  <Breadcrumbs items={[{ label: "二手广场", href: "/products" }, { label: product.title }]} />

  {/* 2. 主从双栏 Grid：桌面端 55% 画廊 + 45% Sticky 购买卡片 */}
  <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
    
    {/* 左侧：媒体画廊与详细介绍 */}
    <div className="space-y-8">
      {/* 图片画廊 */}
      <ImageGallery images={product.images} />

      {/* 详细描述 */}
      <section className="space-y-4 rounded-2xl border border-slate-200/80 bg-white p-6">
        <h2 className="text-lg font-bold text-slate-900">物品详情描述</h2>
        <div className="prose prose-slate max-w-none text-slate-600">
          {product.description}
        </div>
      </section>

      {/* 推荐或评论 */}
      <RelatedSection items={relatedProducts} />
    </div>

    {/* 右侧：Sticky 交易与卖家面板 */}
    <div className="lg:sticky lg:top-24 lg:self-start space-y-6">
      <div className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm space-y-6">
        {/* 标题与价格 */}
        <div>
          <BadgeGroup category={product.category} status={product.status} condition={product.condition} />
          <h1 className="mt-3 text-2xl font-bold text-slate-900">{product.title}</h1>
          <PriceDisplay price={product.price} originalPrice={product.originalPrice} size="lg" />
        </div>

        {/* 关键交易属性 */}
        <MetaList location={product.locationText} campus={product.campus} createdAt={product.createdAt} />

        {/* 卖家信息组件 */}
        <UserSummaryCard user={product.seller} />

        {/* 主要操作区 */}
        <div className="flex gap-3 pt-2">
          <RentalFavoriteButton productId={product.id} isFavorited={isFavorited} count={product.favoriteCount} />
          <ContactButton sellerId={product.seller.id} productId={product.id} />
          <BuyButton onClick={() => setBuyOpen(true)}>立即购买</BuyButton>
        </div>
      </div>
    </div>
  </div>

  {/* 移动端 Sticky Action Bar */}
  <MobileActionBar>
    <FavoriteButton />
    <ContactButton />
    <BuyButton onClick={() => setBuyOpen(true)} />
  </MobileActionBar>

  {/* 弹窗与抽屉（隐藏于默认流） */}
  <PurchaseDrawer open={buyOpen} onOpenChange={setBuyOpen} product={product} />
  <ReportDialog open={reportOpen} onOpenChange={setReportOpen} productId={product.id} />
</PageContainer>
```

---

## 3. 表单页面模板 (Form Page Template)

适用于：`/products/new`, `/rentals/new`, `/services/new`, `/errands/new`, `/profile/edit`

```tsx
<PageContainer maxWidth="form">
  <PageHeader
    title="发布二手闲置商品"
    description="准确填写商品信息，有助于更快完成交易"
  />

  <form action={handleSubmit} className="mt-8 space-y-8">
    {/* 模块1：图片 */}
    <FormSection title="商品图片" description="上传清晰的实物照片，最多 9 张">
      <ImageUploader name="images" max={9} />
    </FormSection>

    {/* 模块2：基本信息 */}
    <FormSection title="基本信息" description="填写标题、分类与成色描述">
      <FormField label="商品标题" required>
        <Input name="title" placeholder="如：95新 罗技 MX Master 3S 鼠标" />
      </FormField>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="商品分类" required>
          <Select name="categoryId" options={categories} />
        </FormField>
        <FormField label="成色状况" required>
          <Select name="condition" options={conditions} />
        </FormField>
      </div>
      <FormField label="详细描述" required>
        <Textarea name="description" placeholder="描述商品的购买时间、使用痕迹、转手原因等..." />
      </FormField>
    </FormSection>

    {/* 模块3：价格与交易 */}
    <FormSection title="价格与交易" description="设定期望价格与当面交易地点">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="转让价格 (元)" required>
          <Input name="price" type="number" step="0.01" prefix="¥" />
        </FormField>
        <FormField label="原价 (选填)">
          <Input name="originalPrice" type="number" step="0.01" prefix="¥" />
        </FormField>
      </div>
      <FormField label="当面交易地点" required hint="建议约定在学校食堂、图书馆门口等公共区域">
        <Input name="locationText" placeholder="如：三食堂门口 / 10号楼宿舍楼下" />
      </FormField>
    </FormSection>

    {/* 提交区 */}
    <div className="flex items-center justify-end gap-4 pt-4">
      <SecondaryButton href="/products">取消</SecondaryButton>
      <PrimaryButton type="submit">确认发布</PrimaryButton>
    </div>
  </form>
</PageContainer>
```
