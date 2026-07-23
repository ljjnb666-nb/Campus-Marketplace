import {
  PrismaClient,
  ProductCondition,
  RentalPricingUnit,
  ServicePricingUnit,
  UserRole,
  VerificationStatus,
} from "@prisma/client";
import { hashSync } from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  await prisma.review.deleteMany();
  await prisma.report.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversationParticipant.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.order.deleteMany();
  await prisma.favorite.deleteMany();
  await prisma.productImage.deleteMany();
  await prisma.product.deleteMany();
  await prisma.errandTask.deleteMany();
  await prisma.serviceListing.deleteMany();
  await prisma.serviceCategory.deleteMany();

  const campus = await prisma.campus.upsert({
    where: { slug: "main-campus" },
    update: {
      name: "主校区",
      schoolName: "示例大学",
      district: "华东校区",
    },
    create: {
      name: "主校区",
      slug: "main-campus",
      schoolName: "示例大学",
      district: "华东校区",
    },
  });

  const productCategories = await Promise.all(
    [
      ["教材资料", "books"],
      ["数码产品", "digital"],
      ["宿舍用品", "dorm"],
      ["交通工具", "transport"],
      ["服装鞋包", "fashion"],
      ["体育用品", "sports"],
      ["生活用品", "life"],
      ["其他闲置", "other"],
    ].map(([name, slug], index) =>
      prisma.productCategory.upsert({
        where: { slug },
        update: { name, sortOrder: index },
        create: { name, slug, sortOrder: index },
      }),
    ),
  );

  const errandCategories = await Promise.all(
    [
      ["代取快递", "pickup-delivery"],
      ["代拿外卖", "takeout"],
      ["代打印", "printing"],
      ["代排队", "queue"],
      ["代买物品", "purchase"],
      ["搬运帮忙", "moving"],
      ["物品送达", "delivery"],
      ["其他校园任务", "other-errand"],
    ].map(([name, slug], index) =>
      prisma.errandCategory.upsert({
        where: { slug },
        update: { name, sortOrder: index },
        create: { name, slug, sortOrder: index },
      }),
    ),
  );

  const serviceCategories = await Promise.all(
    [
      ["摄影", "photography"],
      ["视频剪辑", "video-editing"],
      ["平面设计", "graphic-design"],
      ["PPT 制作", "ppt-design"],
      ["电脑维修", "computer-repair"],
      ["编程辅导", "programming-tutoring"],
      ["课程辅导", "course-tutoring"],
      ["乐器陪练", "music-practice"],
      ["健身陪练", "fitness-coaching"],
      ["活动协助", "event-support"],
      ["宠物照顾", "pet-care"],
      ["其他服务", "other-service"],
    ].map(([name, slug], index) =>
      prisma.serviceCategory.upsert({
        where: { slug },
        update: { name, sortOrder: index },
        create: { name, slug, sortOrder: index },
      }),
    ),
  );

  await prisma.user.upsert({
    where: { email: "admin@campus.local" },
    update: {
      name: "平台管理员",
      schoolName: campus.schoolName,
      campusId: campus.id,
      role: UserRole.ADMIN,
      verificationStatus: VerificationStatus.VERIFIED,
    },
    create: {
      name: "平台管理员",
      email: "admin@campus.local",
      passwordHash: hashSync("Admin123456", 10),
      schoolName: campus.schoolName,
      campusId: campus.id,
      role: UserRole.ADMIN,
      verificationStatus: VerificationStatus.VERIFIED,
    },
  });

  const users = await Promise.all(
    Array.from({ length: 10 }).map((_, index) =>
      prisma.user.upsert({
        where: { email: `student${index + 1}@campus.local` },
        update: {
          name: `学生${index + 1}`,
          schoolName: campus.schoolName,
          college: "信息工程学院",
          grade: `${2020 + (index % 4)}级`,
          campusId: campus.id,
          verificationStatus: index < 7 ? VerificationStatus.VERIFIED : VerificationStatus.PENDING,
        },
        create: {
          name: `学生${index + 1}`,
          email: `student${index + 1}@campus.local`,
          passwordHash: hashSync("Student123456", 10),
          schoolName: campus.schoolName,
          college: "信息工程学院",
          grade: `${2020 + (index % 4)}级`,
          campusId: campus.id,
          verificationStatus: index < 7 ? VerificationStatus.VERIFIED : VerificationStatus.PENDING,
        },
      }),
    ),
  );

  const products = await Promise.all(
    Array.from({ length: 20 }).map((_, index) =>
      prisma.product.create({
        data: {
          title: `二手商品 ${index + 1}`,
          description: `这是第 ${index + 1} 个二手商品，支持校内当面交易。`,
          price: `${20 + index * 5}`,
          originalPrice: `${80 + index * 8}`,
          locationText: ["图书馆门口", "一食堂", "宿舍楼下", "快递站"][index % 4],
          condition:
            [
              ProductCondition.NEW,
              ProductCondition.LIKE_NEW,
              ProductCondition.LIGHTLY_USED,
              ProductCondition.NORMAL_USED,
            ][index % 4],
          sellerId: users[index % users.length].id,
          campusId: campus.id,
          categoryId: productCategories[index % productCategories.length].id,
          images: {
            create: [{ url: "/uploads/placeholders/product-cover.svg", sortOrder: 0 }],
          },
        },
      }),
    ),
  );

  const errands = await Promise.all(
    Array.from({ length: 10 }).map((_, index) =>
      prisma.errandTask.create({
        data: {
          title: `跑腿任务 ${index + 1}`,
          description: `帮忙完成第 ${index + 1} 个校园跑腿任务。`,
          categoryId: errandCategories[index % errandCategories.length].id,
          reward: `${6 + index}`,
          pickupLocation: ["快递站", "校门口", "打印店"][index % 3],
          deliveryLocation: ["宿舍 A", "教学楼 B", "实验楼 C"][index % 3],
          deadline: new Date(Date.now() + (index + 1) * 60 * 60 * 1000),
          publisherId: users[index % users.length].id,
          campusId: campus.id,
        },
      }),
    ),
  );

  const services = await Promise.all(
    Array.from({ length: 10 }).map((_, index) =>
      prisma.serviceListing.create({
        data: {
          title: `技能服务 ${index + 1}`,
          description: `提供第 ${index + 1} 项校园技能服务。`,
          categoryId: serviceCategories[index % serviceCategories.length].id,
          price: `${30 + index * 10}`,
          pricingUnit:
            index % 2 === 0 ? ServicePricingUnit.PER_SESSION : ServicePricingUnit.PER_HOUR,
          locationText: ["线上", "图书馆", "创新中心"][index % 3],
          availableSchedule: "周末与晚间",
          providerId: users[index % users.length].id,
          campusId: campus.id,
        },
      }),
    ),
  );

  const orders = await Promise.all(
    Array.from({ length: 10 }).map((_, index) =>
      prisma.order.create({
        data: {
          orderNo: `CM2026${String(index + 1).padStart(5, "0")}`,
          type: index < 4 ? "PRODUCT" : index < 7 ? "ERRAND" : "SERVICE",
          amount: `${20 + index * 8}`,
          meetingLocation: "校内线下交付",
          paymentStatus: "OFFLINE_PENDING",
          buyerId: users[(index + 1) % users.length].id,
          sellerId: users[index % users.length].id,
          productId: index < 4 ? products[index].id : null,
          errandTaskId: index >= 4 && index < 7 ? errands[index - 4].id : null,
          serviceListingId: index >= 7 ? services[index - 7].id : null,
        },
      }),
    ),
  );

  for (let index = 0; index < 20; index += 1) {
    try {
      await prisma.review.create({
        data: {
          orderId: orders[index % orders.length].id,
          authorId: users[index % users.length].id,
          targetUserId: users[(index + 1) % users.length].id,
          rating: 4 + (index % 2),
          content: "沟通顺畅，交付效率高。",
          tags: ["回复及时", "交易顺利"],
        },
      });
    } catch {
      // Skip duplicate composite keys generated by the sample order pool.
    }
  }

  const conversation = await prisma.conversation.create({
    data: {
      title: "商品咨询",
      participants: {
        create: [{ userId: users[0].id }, { userId: users[1].id }],
      },
    },
  });

  await Promise.all(
    Array.from({ length: 10 }).map((_, index) =>
      prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderId: users[index % 2].id,
          content: `这是第 ${index + 1} 条站内消息。`,
        },
      }),
    ),
  );

  await Promise.all(
    Array.from({ length: 5 }).map((_, index) =>
      prisma.report.create({
        data: {
          targetType: "PRODUCT",
          reason: index % 2 === 0 ? "FAKE_INFO" : "ADVERTISEMENT",
          detail: "示例举报内容，待管理员处理。",
          reporterId: users[index].id,
          productId: products[index].id,
        },
      }),
    ),
  );

  // ============================================================
  // 租赁模块种子数据
  // ============================================================

  // 清空租赁表（按依赖顺序）
  await prisma.rentalReview.deleteMany();
  await prisma.rentalDispute.deleteMany();
  await prisma.rentalDamageClaim.deleteMany();
  await prisma.rentalExtensionRequest.deleteMany();
  await prisma.rentalReturnRecord.deleteMany();
  await prisma.rentalHandoverRecord.deleteMany();
  await prisma.rentalOrderStatusLog.deleteMany();
  await prisma.rentalOrder.deleteMany();
  await prisma.rentalUnavailablePeriod.deleteMany();
  await prisma.rentalListingImage.deleteMany();
  await prisma.rentalListing.deleteMany();
  await prisma.rentalCategory.deleteMany();

  // 租赁分类
  const rentalCategories = await Promise.all(
    [
      ["自行车 / 电动车", "bike", "自行车、电动车等交通工具"],
      ["相机 / 摄影器材", "camera", "单反、无人机、三脚架等摄影设备"],
      ["数码 / 电子设备", "electronics", "充电宝、投影仪、音响等电子设备"],
      ["教材 / 学习用品", "study", "教材、计算器、工程绘图仪等"],
      ["乐器", "music", "吉他、架子鼓、钢琴等各类乐器"],
      ["体育用品", "sports", "球类、健身器材、户外装备"],
      ["露营 / 户外", "outdoor", "帐篷、睡袋、炉具等露营装备"],
      ["服装 / 正装", "clothing", "西装、礼服、舞台服装等"],
      ["游戏 / 娱乐", "gaming", "游戏机、VR设备、桌游等"],
      ["工具 / 其他", "tools", "电钻、梯子等工具及其他物品"],
    ].map(([name, slug, description], index) =>
      prisma.rentalCategory.upsert({
        where: { slug },
        update: { name, description, sortOrder: index },
        create: { name, slug, description, sortOrder: index },
      }),
    ),
  );

  // 获取种子用户（复用现有用户）
  const seedUser1 = await prisma.user.findFirst({ where: { email: "student1@campus.local" } });
  const seedUser2 = await prisma.user.findFirst({ where: { email: "student2@campus.local" } });

  if (seedUser1 && seedUser2) {
    const [bikeCat, cameraCat, electronicsCat, studyCat, musicCat, sportsCat, outdoorCat, clothingCat] =
      rentalCategories;

    // 租赁物品列表
    const rentalListingData = [
      {
        ownerId: seedUser1.id,
        categoryId: bikeCat.id,
        title: "捷安特公路自行车，骑行代步首选",
        description: "捷安特 ATX 660 公路车，车况良好，变速齐全，适合日常代步和短途骑行。配有车锁，按天出租。",
        condition: "NORMAL_USED" as ProductCondition,
        brand: "捷安特",
        price: "15.00",
        pricingUnit: "PER_DAY" as RentalPricingUnit,
        depositAmount: "100.00",
        minimumDuration: 1,
        maximumDuration: 30,
        pickupLocation: "南门宿舍区 A 栋门口",
        returnLocation: "南门宿舍区 A 栋门口",
        usageRules: "请勿骑行上山道路，不允许搭载他人，归还时请锁好车",
      },
      {
        ownerId: seedUser2.id,
        categoryId: cameraCat.id,
        title: "索尼 A7M3 全画幅相机出租（可选配镜头）",
        description: "索尼 A7 III 全画幅无反相机，配 28-70mm 套机镜头，适合写真、旅拍、活动摄影。有说明书，可短期教学。",
        condition: "LIKE_NEW" as ProductCondition,
        brand: "Sony",
        referenceValue: "15000.00",
        price: "80.00",
        pricingUnit: "PER_DAY" as RentalPricingUnit,
        depositAmount: "2000.00",
        minimumDuration: 1,
        maximumDuration: 7,
        pickupLocation: "图书馆一楼大厅",
        returnLocation: "图书馆一楼大厅",
        damagePolicy: "归还时若有明显划痕或功能损坏，需赔偿维修费用",
      },
      {
        ownerId: seedUser1.id,
        categoryId: electronicsCat.id,
        title: "大容量充电宝出租，20000mAh",
        description: "Anker 品牌 20000mAh 充电宝，支持 PD 快充，可同时为两台设备充电。适合外出考察、支教、出行使用。",
        condition: "LIKE_NEW" as ProductCondition,
        brand: "Anker",
        price: "5.00",
        pricingUnit: "PER_DAY" as RentalPricingUnit,
        depositAmount: "50.00",
        minimumDuration: 1,
        maximumDuration: 14,
        pickupLocation: "东区食堂二楼",
        returnLocation: "东区食堂二楼",
      },
      {
        ownerId: seedUser2.id,
        categoryId: studyCat.id,
        title: "德州仪器 TI-84 Plus 图形计算器",
        description: "原装 TI-84 Plus 图形计算器，适合高数、线代、概率论考试使用。电池已新换。",
        condition: "NORMAL_USED" as ProductCondition,
        brand: "Texas Instruments",
        price: "8.00",
        pricingUnit: "PER_DAY" as RentalPricingUnit,
        depositAmount: "200.00",
        minimumDuration: 1,
        maximumDuration: 14,
        pickupLocation: "理工楼 C303",
        returnLocation: "理工楼 C303",
      },
      {
        ownerId: seedUser1.id,
        categoryId: musicCat.id,
        title: "民谣吉他出租，初学者友好",
        description: "雅马哈 F310 民谣吉他，新手友好，音色清脆。配有背包、拨片、变调夹。非常适合社团活动或短期练习。",
        condition: "NORMAL_USED" as ProductCondition,
        brand: "Yamaha",
        price: "25.00",
        pricingUnit: "PER_DAY" as RentalPricingUnit,
        depositAmount: "300.00",
        minimumDuration: 1,
        maximumDuration: 30,
        pickupLocation: "艺术楼 101 排练室",
        returnLocation: "艺术楼 101 排练室",
        usageRules: "请勿在潮湿环境存放，不允许改装调弦以外的操作",
      },
      {
        ownerId: seedUser2.id,
        categoryId: sportsCat.id,
        title: "羽毛球拍套装出租（2 只拍 + 球）",
        description: "尤尼克斯羽毛球拍 2 只，含羽毛球一桶，适合双打娱乐。拍弦正常，无断裂。",
        condition: "NORMAL_USED" as ProductCondition,
        brand: "YONEX",
        price: "15.00",
        pricingUnit: "PER_DAY" as RentalPricingUnit,
        depositAmount: "100.00",
        minimumDuration: 1,
        maximumDuration: 7,
        pickupLocation: "体育馆南门存包处",
        returnLocation: "体育馆南门存包处",
      },
      {
        ownerId: seedUser1.id,
        categoryId: outdoorCat.id,
        title: "双人帐篷出租，适合校内草坪露营",
        description: "牧高笛 2 人帐篷，防水防风，搭建简单，适合草坪野餐或短途郊游。含地钉、收纳袋。",
        condition: "LIKE_NEW" as ProductCondition,
        brand: "MOBIGARDEN",
        price: "40.00",
        pricingUnit: "PER_DAY" as RentalPricingUnit,
        depositAmount: "300.00",
        minimumDuration: 1,
        maximumDuration: 7,
        pickupLocation: "西区仓库 B1",
        returnLocation: "西区仓库 B1",
        usageRules: "归还前请清洁干净，若下雨后使用请晾干后归还",
      },
      {
        ownerId: seedUser2.id,
        categoryId: clothingCat.id,
        title: "男士西装（175cm / M 码）",
        description: "深蓝色商务西装一套（上衣+裤子），适合面试、毕业典礼、正式活动。九成新，已干洗。",
        condition: "LIKE_NEW" as ProductCondition,
        price: "30.00",
        pricingUnit: "PER_DAY" as RentalPricingUnit,
        depositAmount: "200.00",
        minimumDuration: 1,
        maximumDuration: 3,
        pickupLocation: "北区公寓 D 栋 405",
        returnLocation: "北区公寓 D 栋 405",
        damagePolicy: "如有污渍或破损，需承担干洗或修缮费用",
      },
      {
        ownerId: seedUser1.id,
        categoryId: electronicsCat.id,
        title: "投影仪出租，1080P 高清，适合宿舍观影",
        description: "极米 Z6X 投影仪，1080P 分辨率，亮度 1600 ANSI lm，支持手机投屏。适合宿舍观影或班级活动。",
        condition: "LIKE_NEW" as ProductCondition,
        brand: "极米",
        referenceValue: "2500.00",
        price: "50.00",
        pricingUnit: "PER_DAY" as RentalPricingUnit,
        depositAmount: "500.00",
        minimumDuration: 1,
        maximumDuration: 3,
        pickupLocation: "南区 203",
        returnLocation: "南区 203",
      },
      {
        ownerId: seedUser2.id,
        categoryId: cameraCat.id,
        title: "大疆 Mini 3 无人机出租",
        description: "大疆 Mini 3 无人机，飞行时间 34 分钟，拍摄 4K 视频，适合校园外景拍摄。含 2 块电池、收纳包。",
        condition: "LIKE_NEW" as ProductCondition,
        brand: "DJI",
        referenceValue: "3500.00",
        price: "120.00",
        pricingUnit: "PER_DAY" as RentalPricingUnit,
        depositAmount: "1000.00",
        minimumDuration: 1,
        maximumDuration: 3,
        pickupLocation: "创客空间 101",
        returnLocation: "创客空间 101",
        usageRules: "需具备无人机驾驶基础，禁止在禁飞区域飞行，归还前请清洁机身",
        damagePolicy: "若因操作失误导致损坏，需全额赔偿",
      },
    ];

    for (const data of rentalListingData) {
      const { referenceValue, ...rest } = data;
      await prisma.rentalListing.create({
        data: {
          ...rest,
          campusId: campus.id,
          availableQuantity: 1,
          totalQuantity: 1,
          requiresApproval: true,
          status: "AVAILABLE",
          referenceValue: referenceValue ? parseFloat(referenceValue) : undefined,
        },
      });
    }

    console.log(`✅ 已创建 ${rentalListingData.length} 个租赁物品`);
  } else {
    console.log("⚠️  未找到种子用户，跳过租赁物品创建");
  }

  console.log("✅ 租赁分类已创建:", rentalCategories.length, "个");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
