import { Prisma, RentalPricingUnit } from "@prisma/client";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

export type RentalListingQuery = {
  q?: string;
  categoryId?: string;
  campusId?: string;
  pricingUnit?: string;
  minPrice?: string;
  maxPrice?: string;
  noDeposit?: boolean;
  verifiedOwnerOnly?: boolean;
  sort?: "latest" | "price_asc" | "price_desc" | "popular";
  page?: number;
};

export async function getRentalListings(query: RentalListingQuery = {}) {
  const page = Math.max(1, query.page ?? 1);
  const PAGE_SIZE = 12;

  let orderBy: Prisma.RentalListingOrderByWithRelationInput | Prisma.RentalListingOrderByWithRelationInput[] = { createdAt: "desc" };
  if (query.sort === "price_asc") {
    orderBy = [{ price: "asc" }, { createdAt: "desc" }];
  } else if (query.sort === "price_desc") {
    orderBy = [{ price: "desc" }, { createdAt: "desc" }];
  } else if (query.sort === "popular") {
    orderBy = [{ favoriteCount: "desc" }, { createdAt: "desc" }];
  }

  const where: Prisma.RentalListingWhereInput = {
    deletedAt: null,
    status: "AVAILABLE",
  };

  if (query.q) {
    where.OR = [
      { title: { contains: query.q, mode: "insensitive" } },
      { description: { contains: query.q, mode: "insensitive" } },
    ];
  }
  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.campusId) where.campusId = query.campusId;
  if (query.pricingUnit) where.pricingUnit = query.pricingUnit as RentalPricingUnit;

  if (query.minPrice || query.maxPrice) {
    where.price = {};
    if (query.minPrice) where.price.gte = new Prisma.Decimal(query.minPrice);
    if (query.maxPrice) where.price.lte = new Prisma.Decimal(query.maxPrice);
  }

  if (query.noDeposit) {
    where.depositAmount = { equals: new Prisma.Decimal(0) };
  }

  if (query.verifiedOwnerOnly) {
    where.owner = { verificationStatus: "VERIFIED" };
  }

  const [items, total] = await Promise.all([
    prisma.rentalListing.findMany({
      where,
      orderBy,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        category: { select: { id: true, name: true } },
        campus: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true, verificationStatus: true } },
        images: { orderBy: { sortOrder: "asc" }, take: 1 },
      },
    }),
    prisma.rentalListing.count({ where }),
  ]);

  return {
    items,
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function getRentalListingDetail(
  id: string,
  currentUserId?: string,
  options?: { countView?: boolean },
) {
  const listing = await prisma.rentalListing.findFirst({
    where: { id, deletedAt: null },
    include: {
      category: true,
      campus: true,
      owner: {
        select: {
          id: true,
          name: true,
          verificationStatus: true,
          rentalOwnerCount: true,
          rentalPositiveRate: true,
          createdAt: true,
        },
      },
      images: { orderBy: { sortOrder: "asc" } },
      unavailablePeriods: true,
    },
  });

  if (!listing) notFound();

  // generateMetadata 等只读调用传 countView: false，避免浏览量被重复计数
  if (options?.countView !== false) {
    await prisma.rentalListing.update({
      where: { id: listing.id },
      data: { viewCount: { increment: 1 } },
    });
  }

  const [reviews, isFavorited] = await Promise.all([
    prisma.rentalReview.findMany({
      where: { order: { rentalListingId: id }, targetUserId: listing.ownerId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { author: { select: { id: true, name: true } } },
    }),
    currentUserId
      ? prisma.rentalFavorite.findUnique({
          where: {
            userId_rentalListingId: {
              userId: currentUserId,
              rentalListingId: id,
            },
          },
          select: { id: true },
        }).then(Boolean)
      : Promise.resolve(false),
  ]);

  return { listing, reviews, isFavorited };
}


export async function getRentalListingForEdit(id: string, userId: string) {
  const listing = await prisma.rentalListing.findFirst({
    where: { id, ownerId: userId, deletedAt: null },
    include: { images: { orderBy: { sortOrder: "asc" } } },
  });

  if (!listing) notFound();
  return listing;
}

export async function getMyRentalListings(userId: string) {
  return prisma.rentalListing.findMany({
    where: { ownerId: userId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: {
      category: true,
      images: { orderBy: { sortOrder: "asc" }, take: 1 },
    },
  });
}

export async function getRentalFormMeta() {
  const [categories, campuses] = await Promise.all([
    prisma.rentalCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    prisma.campus.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return { categories, campuses };
}
