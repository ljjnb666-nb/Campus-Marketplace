import React from "react";
import Link from "next/link";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { OrderCardUnified, UnifiedOrderData } from "@/components/order/order-card-unified";
import { requireUser } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { Search, RotateCcw, Filter, ShoppingBag, Package, Truck, Briefcase, Repeat } from "lucide-react";

export const dynamic = "force-dynamic";

const ORDER_TABS = [
  { key: "all", label: "全部订单", icon: Package },
  { key: "product", label: "二手商品", icon: ShoppingBag },
  { key: "errand", label: "跑腿求助", icon: Truck },
  { key: "service", label: "技能服务", icon: Briefcase },
  { key: "rental-renter", label: "我的租用", icon: Repeat },
  { key: "rental-owner", label: "我的出租", icon: Repeat },
] as const;

export default async function MyOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{
    type?: string;
    q?: string;
    status?: string;
  }>;
}) {
  const params = await searchParams;
  const user = await requireUser();
  const currentTab = params.type || "all";
  const searchKeyword = params.q?.trim() || "";

  // 1. 并行拉取用户参与的 Order 与 RentalOrder 模型数据
  const [orders, renterRentalOrders, ownerRentalOrders] = await Promise.all([
    // 普通商品/跑腿/服务 Orders
    prisma.order.findMany({
      where: {
        OR: [{ buyerId: user.id }, { sellerId: user.id }],
      },
      include: {
        buyer: { select: { id: true, name: true, avatarUrl: true, schoolName: true } },
        seller: { select: { id: true, name: true, avatarUrl: true, schoolName: true } },
        product: { select: { id: true, title: true, images: { take: 1 } } },
        errandTask: { select: { id: true, title: true } },
        serviceListing: { select: { id: true, title: true, coverImageUrl: true } },
        reviews: { select: { authorId: true } },
      },
      orderBy: { createdAt: "desc" },
    }),

    // 我的租用 RentalOrders
    prisma.rentalOrder.findMany({
      where: { renterId: user.id },
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true, schoolName: true } },
        rentalListing: { select: { id: true, title: true, images: { take: 1 } } },
        reviews: { select: { authorId: true } },
      },
      orderBy: { createdAt: "desc" },
    }),

    // 我的出租 RentalOrders
    prisma.rentalOrder.findMany({
      where: { ownerId: user.id },
      include: {
        renter: { select: { id: true, name: true, avatarUrl: true, schoolName: true } },
        rentalListing: { select: { id: true, title: true, images: { take: 1 } } },
        reviews: { select: { authorId: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // 2. 映射归一化为 UnifiedOrderData 数组
  const unifiedList: UnifiedOrderData[] = [];

  // 2.1 处理通用 Order (PRODUCT / ERRAND / SERVICE)
  for (const o of orders) {
    const isBuyer = o.buyerId === user.id;
    const title =
      o.type === "PRODUCT"
        ? o.product?.title ?? "商品已下架"
        : o.type === "ERRAND"
        ? o.errandTask?.title ?? "跑腿任务"
        : o.serviceListing?.title ?? "技能服务";

    const detailHref =
      o.type === "PRODUCT" && o.product
        ? `/products/${o.product.id}`
        : o.type === "ERRAND" && o.errandTask
        ? `/errands/${o.errandTask.id}`
        : o.type === "SERVICE" && o.serviceListing
        ? `/services/${o.serviceListing.id}`
        : "/my/orders";

    const imageUrl =
      o.type === "PRODUCT"
        ? o.product?.images[0]?.url
        : o.type === "SERVICE"
        ? o.serviceListing?.coverImageUrl
        : null;

    const userRole = isBuyer
      ? o.type === "ERRAND"
        ? "publisher"
        : "buyer"
      : o.type === "ERRAND"
      ? "accepter"
      : "seller";

    unifiedList.push({
      id: o.id,
      orderNo: o.orderNo,
      type: o.type,
      status: o.status,
      amount: o.amount.toString(),
      title,
      imageUrl,
      createdAt: o.createdAt,
      meetingLocation: o.meetingLocation,
      note: o.note,
      counterparty: isBuyer ? o.seller : o.buyer,
      userRole,
      detailHref,
      hasReviewed: o.reviews.some((r) => r.authorId === user.id),
    });
  }

  // 2.2 处理我的租用 RentalOrder
  for (const ro of renterRentalOrders) {
    unifiedList.push({
      id: ro.id,
      orderNo: ro.orderNumber,
      type: "RENTAL",
      status: ro.status,
      amount: ro.finalAmount.toString(),
      depositAmount: ro.depositAmount.toString(),
      title: ro.rentalListing.title,
      imageUrl: ro.rentalListing.images[0]?.url,
      createdAt: ro.createdAt,
      meetingLocation: ro.pickupLocationSnapshot,
      counterparty: ro.owner,
      userRole: "renter",
      detailHref: `/rental-orders/${ro.id}`,
      hasReviewed: ro.reviews.some((r) => r.authorId === user.id),
    });
  }

  // 2.3 处理我的出租 RentalOrder
  for (const ro of ownerRentalOrders) {
    unifiedList.push({
      id: ro.id,
      orderNo: ro.orderNumber,
      type: "RENTAL",
      status: ro.status,
      amount: ro.finalAmount.toString(),
      depositAmount: ro.depositAmount.toString(),
      title: ro.rentalListing.title,
      imageUrl: ro.rentalListing.images[0]?.url,
      createdAt: ro.createdAt,
      meetingLocation: ro.pickupLocationSnapshot,
      counterparty: ro.renter,
      userRole: "owner",
      detailHref: `/rental-orders/${ro.id}`,
      hasReviewed: ro.reviews.some((r) => r.authorId === user.id),
    });
  }

  // 3. 排序 (创建时间倒序)
  unifiedList.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // 4. 按 Tab 和 关键词筛选
  const filteredList = unifiedList.filter((item) => {
    // 4.1 按 Tab 筛选
    if (currentTab === "product" && item.type !== "PRODUCT") return false;
    if (currentTab === "errand" && item.type !== "ERRAND") return false;
    if (currentTab === "service" && item.type !== "SERVICE") return false;
    if (currentTab === "rental-renter" && (item.type !== "RENTAL" || item.userRole !== "renter")) return false;
    if (currentTab === "rental-owner" && (item.type !== "RENTAL" || item.userRole !== "owner")) return false;

    // 4.2 按关键词筛选
    if (searchKeyword) {
      const matchTitle = item.title.toLowerCase().includes(searchKeyword.toLowerCase());
      const matchOrderNo = item.orderNo.toLowerCase().includes(searchKeyword.toLowerCase());
      const matchParty = item.counterparty.name.toLowerCase().includes(searchKeyword.toLowerCase());
      if (!matchTitle && !matchOrderNo && !matchParty) return false;
    }

    return true;
  });

  return (
    <PageContainer maxWidth="standard">
      {/* 页头 */}
      <PageHeader
        title="统一订单中心"
        description="一站式管理二手买卖、跑腿代办、技能服务与物品租赁订单"
      />

      {/* 1. 顶部 Tab 分段筛选栏 */}
      <div className="mb-6 flex overflow-x-auto pb-1 no-scrollbar border-b border-slate-200/80 dark:border-slate-800">
        <div className="flex items-center gap-1.5 min-w-max">
          {ORDER_TABS.map((tab) => {
            const isActive = currentTab === tab.key;
            const Icon = tab.icon;

            const buildTabHref = () => {
              const search = new URLSearchParams();
              if (tab.key !== "all") search.set("type", tab.key);
              if (searchKeyword) search.set("q", searchKeyword);
              const query = search.toString();
              return query ? `/my/orders?${query}` : "/my/orders";
            };

            return (
              <Link
                key={tab.key}
                href={buildTabHref()}
                className={`flex items-center gap-2 rounded-2xl px-4 py-2.5 text-xs font-bold transition ${
                  isActive
                    ? "bg-slate-900 text-white shadow-xs dark:bg-indigo-600"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800"
                }`}
              >
                <Icon className="size-3.5" />
                <span>{tab.label}</span>
              </Link>
            );
          })}
        </div>
      </div>

      {/* 2. 关键词搜索条 */}
      <form className="mb-6 flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-3 size-4 text-slate-400" />
          <input
            type="text"
            name="q"
            defaultValue={searchKeyword}
            placeholder="搜索订单编号、商品/服务名称或交易对方姓名..."
            className="w-full rounded-2xl border border-slate-200 bg-white pl-10 pr-4 py-2.5 text-xs text-slate-900 outline-none transition focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
          />
          {currentTab !== "all" && <input type="hidden" name="type" value={currentTab} />}
        </div>

        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-2xl bg-slate-900 px-5 py-2.5 text-xs font-bold text-white shadow-xs hover:bg-slate-800 dark:bg-indigo-600"
        >
          <Filter className="size-3.5" />
          <span>筛选</span>
        </button>

        {searchKeyword && (
          <Link
            href={`/my/orders?type=${currentTab}`}
            className="inline-flex items-center gap-1 rounded-2xl border border-slate-200 px-3.5 py-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-400"
          >
            <RotateCcw className="size-3.5" />
            <span>清空</span>
          </Link>
        )}
      </form>

      {/* 3. 订单列表与空状态 */}
      {filteredList.length === 0 ? (
        <EmptyState
          title="暂无相关订单记录"
          description="没有找到符合条件的订单。快去广场逛逛或发布你的闲置物品吧！"
          action={
            <Link
              href="/products"
              className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-slate-800 dark:bg-indigo-600"
            >
              <span>去逛逛广场</span>
            </Link>
          }
        />
      ) : (
        <div className="space-y-4">
          {filteredList.map((item) => (
            <OrderCardUnified key={`${item.type}-${item.id}`} order={item} />
          ))}
        </div>
      )}
    </PageContainer>
  );
}
