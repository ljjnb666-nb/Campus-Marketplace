import { revalidatePath } from "next/cache";

// 每个函数对应一种固定的 revalidatePath 扇出形态；
// 修改扇出范围时必须同步核对所有调用方，避免漏刷页面缓存。

// 通用订单（商品/服务/跑腿）状态变化后的缓存刷新
export function revalidateOrderViews(options: {
  productId?: string;
  serviceId?: string;
  errandId?: string;
}) {
  revalidatePath("/my/orders");
  revalidatePath("/products");
  revalidatePath("/services");
  revalidatePath("/errands");
  revalidatePath("/notifications");

  if (options.productId) {
    revalidatePath(`/products/${options.productId}`);
  }

  if (options.serviceId) {
    revalidatePath(`/services/${options.serviceId}`);
  }

  if (options.errandId) {
    revalidatePath(`/errands/${options.errandId}`);
  }
}

// 跑腿任务增删改后的缓存刷新
export function revalidateErrandViews(errandId?: string) {
  revalidatePath("/");
  revalidatePath("/errands");
  revalidatePath("/my/errands");
  revalidatePath("/my/orders");
  revalidatePath("/notifications");

  if (errandId) {
    revalidatePath(`/errands/${errandId}`);
    revalidatePath(`/errands/${errandId}/edit`);
  }
}

// 商品增删改后的缓存刷新
export function revalidateProductViews(productId?: string) {
  revalidatePath("/");
  revalidatePath("/products");
  revalidatePath("/my/products");
  revalidatePath("/my/favorites");

  if (productId) {
    revalidatePath(`/products/${productId}`);
    revalidatePath(`/products/${productId}/edit`);
  }
}

// 服务增删改后的缓存刷新
export function revalidateServiceViews(serviceId?: string) {
  revalidatePath("/");
  revalidatePath("/services");
  revalidatePath("/my/services");

  if (serviceId) {
    revalidatePath(`/services/${serviceId}`);
    revalidatePath(`/services/${serviceId}/edit`);
  }
}

// 租赁订单详情页
export function revalidateRentalOrderViews(orderId: string) {
  revalidatePath(`/rental-orders/${orderId}`);
}

// 租赁订单列表页（不携带订单号时使用）
export function revalidateRentalOrderListViews() {
  revalidatePath("/rental-orders");
}

// 新建租赁申请成功后：租赁市场列表 + 双方角色订单列表
export function revalidateRentalOrderCreationViews() {
  revalidatePath("/rentals");
  revalidatePath("/my/owner-orders");
  revalidatePath("/my/rental-orders");
}

// Phase 7C：listing 治理状态变化（takedown/restore）后的缓存刷新。
// 以各域既有 helper 的扇出为基础，另加 PUBLIC 检索/公开主页/收藏/站点地图
// 与治理面自身；authority 恒为服务器重读（所有 PUBLIC 查询均带 overlay
// 谓词），本扇出仅消除陈旧 UI 提示。
export function revalidateListingModerationViews(
  targetType: "PRODUCT" | "SERVICE" | "ERRAND" | "RENTAL",
  listingId: string,
) {
  revalidatePath("/search");
  revalidatePath("/sitemap.xml");
  revalidatePath("/governance/listings");
  revalidatePath(`/governance/listings/${targetType.toLowerCase()}/${listingId}`);

  switch (targetType) {
    case "PRODUCT":
      revalidateProductViews(listingId);
      break;
    case "SERVICE":
      revalidateServiceViews(listingId);
      break;
    case "ERRAND":
      revalidateErrandViews(listingId);
      break;
    case "RENTAL":
      revalidatePath("/");
      revalidatePath("/rentals");
      revalidatePath("/my/rental-listings");
      revalidatePath(`/rentals/${listingId}`);
      revalidatePath(`/rentals/${listingId}/edit`);
      break;
  }
}
