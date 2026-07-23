import { PrismaClient, UserRole, VerificationStatus } from "@prisma/client";

const prisma = new PrismaClient();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const [
    campus,
    counts,
    admin,
    student1,
    sampleProduct,
    sampleErrand,
    sampleService,
    conversation,
    reportCount,
  ] = await Promise.all([
    prisma.campus.findUnique({
      where: { slug: "main-campus" },
      select: { name: true, schoolName: true, district: true },
    }),
    Promise.all([
      prisma.user.count(),
      prisma.product.count(),
      prisma.errandTask.count(),
      prisma.serviceListing.count(),
      prisma.order.count(),
      prisma.review.count(),
      prisma.message.count(),
      prisma.report.count(),
      prisma.productCategory.count(),
      prisma.errandCategory.count(),
      prisma.serviceCategory.count(),
    ]),
    prisma.user.findUnique({
      where: { email: "admin@campus.local" },
      select: { name: true, role: true, verificationStatus: true },
    }),
    prisma.user.findUnique({
      where: { email: "student1@campus.local" },
      select: { name: true, college: true, grade: true, verificationStatus: true },
    }),
    prisma.product.findFirst({
      where: { title: "二手商品 1" },
      select: { title: true, description: true, locationText: true },
    }),
    prisma.errandTask.findFirst({
      where: { title: "跑腿任务 1" },
      select: { title: true, description: true, pickupLocation: true, deliveryLocation: true },
    }),
    prisma.serviceListing.findFirst({
      where: { title: "技能服务 1" },
      select: { title: true, description: true, locationText: true, availableSchedule: true },
    }),
    prisma.conversation.findFirst({
      orderBy: { createdAt: "asc" },
      select: { title: true, _count: { select: { participants: true, messages: true } } },
    }),
    prisma.report.count({
      where: { targetType: "PRODUCT" },
    }),
  ]);

  const [
    userCount,
    productCount,
    errandCount,
    serviceCount,
    orderCount,
    reviewCount,
    messageCount,
    totalReportCount,
    productCategoryCount,
    errandCategoryCount,
    serviceCategoryCount,
  ] = counts;

  assert(campus, "缺少主校区数据");
  assert(campus.name === "主校区", `校区名称异常: ${campus.name}`);
  assert(campus.schoolName === "示例大学", `学校名称异常: ${campus.schoolName}`);

  assert(userCount === 11, `用户数量异常，期望 11，实际 ${userCount}`);
  assert(productCount === 20, `商品数量异常，期望 20，实际 ${productCount}`);
  assert(errandCount === 10, `任务数量异常，期望 10，实际 ${errandCount}`);
  assert(serviceCount === 10, `服务数量异常，期望 10，实际 ${serviceCount}`);
  assert(orderCount === 10, `订单数量异常，期望 10，实际 ${orderCount}`);
  assert(reviewCount === 10, `评价数量异常，期望 10，实际 ${reviewCount}`);
  assert(messageCount === 10, `消息数量异常，期望 10，实际 ${messageCount}`);
  assert(totalReportCount === 5, `举报数量异常，期望 5，实际 ${totalReportCount}`);
  assert(productCategoryCount === 8, `商品分类数量异常，期望 8，实际 ${productCategoryCount}`);
  assert(errandCategoryCount === 8, `任务分类数量异常，期望 8，实际 ${errandCategoryCount}`);
  assert(serviceCategoryCount === 12, `服务分类数量异常，期望 12，实际 ${serviceCategoryCount}`);

  assert(admin, "缺少管理员账号");
  assert(admin.name === "平台管理员", `管理员名称异常: ${admin.name}`);
  assert(admin.role === UserRole.ADMIN, `管理员角色异常: ${admin.role}`);
  assert(
    admin.verificationStatus === VerificationStatus.VERIFIED,
    `管理员认证状态异常: ${admin.verificationStatus}`,
  );

  assert(student1, "缺少 student1 测试账号");
  assert(student1.name === "学生1", `student1 名称异常: ${student1.name}`);
  assert(student1.college === "信息工程学院", `student1 学院异常: ${student1.college}`);
  assert(student1.grade === "2020级", `student1 年级异常: ${student1.grade}`);
  assert(
    student1.verificationStatus === VerificationStatus.VERIFIED,
    `student1 认证状态异常: ${student1.verificationStatus}`,
  );

  assert(sampleProduct, "缺少商品种子数据");
  assert(sampleProduct.title === "二手商品 1", `样本商品标题异常: ${sampleProduct.title}`);
  assert(
    sampleProduct.description === "这是第 1 个二手商品，支持校内当面交易。",
    `样本商品描述异常: ${sampleProduct.description}`,
  );
  assert(sampleProduct.locationText === "图书馆门口", `样本商品地点异常: ${sampleProduct.locationText}`);

  assert(sampleErrand, "缺少任务种子数据");
  assert(sampleErrand.title === "跑腿任务 1", `样本任务标题异常: ${sampleErrand.title}`);
  assert(
    sampleErrand.description === "帮忙完成第 1 个校园跑腿任务。",
    `样本任务描述异常: ${sampleErrand.description}`,
  );
  assert(sampleErrand.pickupLocation === "快递站", `样本任务取件地异常: ${sampleErrand.pickupLocation}`);
  assert(sampleErrand.deliveryLocation === "宿舍 A", `样本任务送达地异常: ${sampleErrand.deliveryLocation}`);

  assert(sampleService, "缺少服务种子数据");
  assert(sampleService.title === "技能服务 1", `样本服务标题异常: ${sampleService.title}`);
  assert(
    sampleService.description === "提供第 1 项校园技能服务。",
    `样本服务描述异常: ${sampleService.description}`,
  );
  assert(sampleService.locationText === "线上", `样本服务地点异常: ${sampleService.locationText}`);
  assert(sampleService.availableSchedule === "周末与晚间", `样本服务时间异常: ${sampleService.availableSchedule}`);

  assert(conversation, "缺少示例会话");
  assert(conversation.title === "商品咨询", `示例会话标题异常: ${conversation.title}`);
  assert(conversation._count.participants === 2, `会话参与人数异常: ${conversation._count.participants}`);
  assert(conversation._count.messages === 10, `会话消息数异常: ${conversation._count.messages}`);
  assert(reportCount === 5, `商品举报数异常，期望 5，实际 ${reportCount}`);

  console.log("Seed verification passed.");
  console.log(
    JSON.stringify(
      {
        counts: {
          users: userCount,
          products: productCount,
          errands: errandCount,
          services: serviceCount,
          orders: orderCount,
          reviews: reviewCount,
          messages: messageCount,
          reports: totalReportCount,
        },
        samples: {
          campus,
          admin,
          student1,
          sampleProduct,
          sampleErrand,
          sampleService,
          conversation,
        },
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
