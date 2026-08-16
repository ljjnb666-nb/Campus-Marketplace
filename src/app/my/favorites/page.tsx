"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Heart, Package, Key, Briefcase, ClipboardList } from "lucide-react";
import { ProductCard } from "@/components/product/product-card";
import { ErrandCard } from "@/components/errand/errand-card";
import { ServiceCard } from "@/components/service/service-card";
import { RentalListingStatusBadge } from "@/components/rental/rental-status-badge";
import { RentalFavoriteButton } from "@/components/rental/rental-favorite-button";
import { RENTAL_PRICING_UNIT_LABELS } from "@/constants/rental";
import { ERRAND_STATUS_LABELS } from "@/constants/errand";
import {
  SERVICE_PRICING_UNIT_LABELS,
  SERVICE_STATUS_LABELS,
} from "@/constants/service";
import type { ListingStatus, RentalListingStatus } from "@prisma/client";

type TabType = "products" | "rentals" | "errands" | "services";

type ProductFavorite = {
  id: string;
  product: {
    id: string;
    title: string;
    description: string;
    price: string;
    images: Array<{ url: string }>;
    status: string;
    category: { name: string };
    seller: { name: string };
    favoriteCount: number;
  };
};

type RentalFavorite = {
  id: string;
  rentalListing: {
    id: string;
    title: string;
    price: string;
    depositAmount: string;
    images: Array<{ url: string }>;
    status: string;
    pricingUnit: string;
    category: { name: string };
    campus: { name: string };
    owner: { name: string; verificationStatus: string };
    favoriteCount: number;
  };
};

type ErrandFavorite = {
  id: string;
  errandTask: {
    id: string;
    title: string;
    description: string;
    reward: string;
    status: string;
    category: { name: string };
    pickupLocation: string;
    deliveryLocation: string;
    publisher: { name: string; verificationStatus: string };
    deadline: string;
  };
};

type ServiceFavorite = {
  id: string;
  serviceListing: {
    id: string;
    title: string;
    description: string;
    price: string;
    coverImage: string | null;
    status: string;
    pricingUnit: string;
    category: { name: string };
    provider: { name: string; verificationStatus: string };
    locationText: string;
    favoriteCount: number;
  };
};

/**
 * 租赁收藏卡片：RentalCard 需要 pickupLocation（收藏接口不返回，只返回 campus）
 * 且不带收藏切换按钮，无法承载本页的取消收藏交互，故保留原有内联标记。
 */
function RentalFavoriteCard({
  rentalListing,
}: {
  rentalListing: RentalFavorite["rentalListing"];
}) {
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md">
      <Link href={`/rentals/${rentalListing.id}`} className="block">
        <div className="relative aspect-[4/3] overflow-hidden bg-slate-100">
          {rentalListing.images[0]?.url ? (
            <img
              src={rentalListing.images[0].url}
              alt={rentalListing.title}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <span className="text-xs text-slate-400">暂无图片</span>
            </div>
          )}
          <div className="absolute left-3 top-3">
            <RentalListingStatusBadge status={rentalListing.status as RentalListingStatus} />
          </div>
        </div>
      </Link>

      <div className="flex flex-1 flex-col p-4">
        <Link href={`/rentals/${rentalListing.id}`}>
          <h3 className="mb-1 line-clamp-2 font-bold text-slate-900 transition hover:text-indigo-600">
            {rentalListing.title}
          </h3>
        </Link>

        <div className="mb-3 flex items-end gap-1">
          <span className="text-xl font-bold text-indigo-600">
            ¥{Number(rentalListing.price).toFixed(2)}
          </span>
          <span className="mb-0.5 text-xs text-slate-500">
            {RENTAL_PRICING_UNIT_LABELS[
              rentalListing.pricingUnit as keyof typeof RENTAL_PRICING_UNIT_LABELS
            ] ?? ""}
          </span>
        </div>

        <div className="mb-3 flex flex-wrap gap-1.5 text-xs text-slate-500">
          <span className="rounded-lg bg-slate-50 px-2 py-0.5">
            {rentalListing.category.name}
          </span>
          <span className="rounded-lg bg-slate-50 px-2 py-0.5">
            {rentalListing.campus.name}
          </span>
          {Number(rentalListing.depositAmount) === 0 && (
            <span className="rounded-lg bg-indigo-50 px-2 py-0.5 text-indigo-600">
              免押金
            </span>
          )}
        </div>

        <div className="mt-auto flex items-center justify-between">
          <span className="text-xs text-slate-400">
            {rentalListing.owner.name}
            {rentalListing.owner.verificationStatus === "VERIFIED" && " ✓"}
          </span>
          <RentalFavoriteButton
            rentalListingId={rentalListing.id}
            isFavorited={true}
            count={rentalListing.favoriteCount}
            isLoggedIn={true}
          />
        </div>
      </div>
    </div>
  );
}

export default function UnifiedFavoritesPage() {
  const [activeTab, setActiveTab] = useState<TabType>("products");
  const [productFavorites, setProductFavorites] = useState<ProductFavorite[]>([]);
  const [rentalFavorites, setRentalFavorites] = useState<RentalFavorite[]>([]);
  const [errandFavorites, setErrandFavorites] = useState<ErrandFavorite[]>([]);
  const [serviceFavorites, setServiceFavorites] = useState<ServiceFavorite[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadFavorites() {
      setLoading(true);
      try {
        const [productsRes, rentalsRes, errandsRes, servicesRes] = await Promise.all([
          fetch("/api/favorites/products"),
          fetch("/api/favorites/rentals"),
          fetch("/api/favorites/errands"),
          fetch("/api/favorites/services"),
        ]);

        if (productsRes.ok) {
          const data = await productsRes.json();
          setProductFavorites(data.favorites || []);
        }

        if (rentalsRes.ok) {
          const data = await rentalsRes.json();
          setRentalFavorites(data.favorites || []);
        }

        if (errandsRes.ok) {
          const data = await errandsRes.json();
          setErrandFavorites(data.favorites || []);
        }

        if (servicesRes.ok) {
          const data = await servicesRes.json();
          setServiceFavorites(data.favorites || []);
        }
      } catch (error) {
        console.error("Failed to load favorites:", error);
      } finally {
        setLoading(false);
      }
    }

    loadFavorites();
  }, []);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-8 space-y-2">
        <div className="flex items-center gap-3">
          <Heart className="h-7 w-7 text-rose-500" />
          <h1 className="text-3xl font-bold text-slate-950">我的收藏</h1>
        </div>
        <p className="text-sm text-slate-600">
          汇总你收藏的商品、租赁物品、跑腿任务和技能服务，方便集中回看和快速比较
        </p>
      </div>

      <div className="mb-6 flex items-center gap-2 overflow-x-auto border-b border-slate-200 scrollbar-hide">
        <button
          onClick={() => setActiveTab("products")}
          className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition whitespace-nowrap ${
            activeTab === "products"
              ? "border-indigo-600 text-indigo-600"
              : "border-transparent text-slate-600 hover:text-slate-900"
          }`}
        >
          <Package className="h-4 w-4" />
          <span>二手商品</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
            {productFavorites.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab("rentals")}
          className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition whitespace-nowrap ${
            activeTab === "rentals"
              ? "border-indigo-600 text-indigo-600"
              : "border-transparent text-slate-600 hover:text-slate-900"
          }`}
        >
          <Key className="h-4 w-4" />
          <span>租赁物品</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
            {rentalFavorites.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab("errands")}
          className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition whitespace-nowrap ${
            activeTab === "errands"
              ? "border-indigo-600 text-indigo-600"
              : "border-transparent text-slate-600 hover:text-slate-900"
          }`}
        >
          <ClipboardList className="h-4 w-4" />
          <span>跑腿任务</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
            {errandFavorites.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab("services")}
          className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition whitespace-nowrap ${
            activeTab === "services"
              ? "border-indigo-600 text-indigo-600"
              : "border-transparent text-slate-600 hover:text-slate-900"
          }`}
        >
          <Briefcase className="h-4 w-4" />
          <span>技能服务</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
            {serviceFavorites.length}
          </span>
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="text-sm text-slate-500">加载中...</div>
        </div>
      ) : (
        <>
          {activeTab === "products" && (
            <div>
              {productFavorites.length === 0 ? (
                <div className="flex flex-col items-center gap-5 rounded-[28px] border border-slate-200 bg-white p-14 text-center shadow-sm">
                  <Package className="h-14 w-14 text-slate-200" />
                  <div>
                    <p className="text-base font-semibold text-slate-700">暂无收藏</p>
                    <p className="mt-1 text-sm text-slate-500">去商品广场逛逛，收藏感兴趣的商品</p>
                  </div>
                  <Link
                    href="/products"
                    className="rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:from-indigo-700 hover:to-indigo-800"
                  >
                    去商品广场
                  </Link>
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-3">
                  {productFavorites.map(({ id, product }) => (
                    <ProductCard
                      key={id}
                      id={product.id}
                      title={product.title}
                      description={product.description}
                      price={`￥${product.price.toString()}`}
                      status={product.status as ListingStatus}
                      category={product.category.name}
                      seller={product.seller.name}
                      imageUrl={product.images[0]?.url}
                      favoriteCount={product.favoriteCount}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "rentals" && (
            <div>
              {rentalFavorites.length === 0 ? (
                <div className="flex flex-col items-center gap-5 rounded-[28px] border border-slate-200 bg-white p-14 text-center shadow-sm">
                  <Key className="h-14 w-14 text-slate-200" />
                  <div>
                    <p className="text-base font-semibold text-slate-700">暂无收藏</p>
                    <p className="mt-1 text-sm text-slate-500">去租赁广场逛逛，收藏感兴趣的物品</p>
                  </div>
                  <Link
                    href="/rentals"
                    className="rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:from-indigo-700 hover:to-indigo-800"
                  >
                    去租赁广场
                  </Link>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {rentalFavorites.map(({ rentalListing }) => (
                    <RentalFavoriteCard
                      key={rentalListing.id}
                      rentalListing={rentalListing}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "errands" && (
            <div>
              {errandFavorites.length === 0 ? (
                <div className="flex flex-col items-center gap-5 rounded-[28px] border border-slate-200 bg-white p-14 text-center shadow-sm">
                  <ClipboardList className="h-14 w-14 text-slate-200" />
                  <div>
                    <p className="text-base font-semibold text-slate-700">暂无收藏</p>
                    <p className="mt-1 text-sm text-slate-500">去跑腿大厅逛逛，收藏感兴趣的任务</p>
                  </div>
                  <Link
                    href="/errands"
                    className="rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:from-indigo-700 hover:to-indigo-800"
                  >
                    去跑腿大厅
                  </Link>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {errandFavorites.map(({ errandTask }) => (
                    <ErrandCard
                      key={errandTask.id}
                      id={errandTask.id}
                      title={errandTask.title}
                      reward={errandTask.reward}
                      pickupLocation={errandTask.pickupLocation}
                      deliveryLocation={errandTask.deliveryLocation}
                      publisher={errandTask.publisher.name}
                      status={errandTask.status as keyof typeof ERRAND_STATUS_LABELS}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "services" && (
            <div>
              {serviceFavorites.length === 0 ? (
                <div className="flex flex-col items-center gap-5 rounded-[28px] border border-slate-200 bg-white p-14 text-center shadow-sm">
                  <Briefcase className="h-14 w-14 text-slate-200" />
                  <div>
                    <p className="text-base font-semibold text-slate-700">暂无收藏</p>
                    <p className="mt-1 text-sm text-slate-500">去技能服务逛逛，收藏感兴趣的服务</p>
                  </div>
                  <Link
                    href="/services"
                    className="rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:from-indigo-700 hover:to-indigo-800"
                  >
                    去技能服务
                  </Link>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {serviceFavorites.map(({ serviceListing }) => (
                    <ServiceCard
                      key={serviceListing.id}
                      id={serviceListing.id}
                      title={serviceListing.title}
                      description={serviceListing.description}
                      price={serviceListing.price}
                      pricingUnit={
                        serviceListing.pricingUnit as keyof typeof SERVICE_PRICING_UNIT_LABELS
                      }
                      status={serviceListing.status as keyof typeof SERVICE_STATUS_LABELS}
                      provider={serviceListing.provider.name}
                      locationText={serviceListing.locationText}
                      categoryName={serviceListing.category.name}
                      coverImageUrl={serviceListing.coverImage}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
