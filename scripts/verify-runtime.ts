import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const baseUrl = (
  process.env.APP_BASE_URL ??
  process.env.NEXTAUTH_URL ??
  "http://localhost:3000"
).replace(/\/$/, "");

type Check = {
  name: string;
  path: string;
  expected: string[];
  forbidden?: string[];
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchPage(path: string) {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "campus-marketplace-runtime-verify",
    },
  });
  const html = await response.text();
  return { url, response, html };
}

async function main() {
  const [product, errand, service, user] = await Promise.all([
    prisma.product.findFirst({
      where: { deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true },
    }),
    prisma.errandTask.findFirst({
      where: { deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true },
    }),
    prisma.serviceListing.findFirst({
      where: { deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true },
    }),
    prisma.user.findFirst({
      where: { role: "STUDENT", deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  assert(product, "Missing product sample for runtime verification");
  assert(errand, "Missing errand sample for runtime verification");
  assert(service, "Missing service sample for runtime verification");
  assert(user, "Missing public user sample for runtime verification");

  const checks: Check[] = [
    {
      name: "home",
      path: "/",
      expected: [
        "\u6821\u56ed\u96c6\u5e02",
        // hero 文案被渐变 span 拆成两段，按两个连续片段分别断言
        "\u6821\u56ed\u91cc\u7684\u95f2\u7f6e\u4ea4\u6613\u3001\u8dd1\u817f\u63a5\u5355",
        "\u548c\u6280\u80fd\u670d\u52a1\uff0c\u4e00\u7ad9\u89e3\u51b3",
      ],
    },
    {
      name: "products",
      path: "/products",
      // 列表页改版后计数文案不再输出，按页面标题断言
      expected: ["\u5546\u54c1\u5217\u8868"],
      forbidden: ["\u6211\u7684\u5546\u54c1", "\u53d1\u5e03\u5546\u54c1"],
    },
    {
      name: "errands",
      path: "/errands",
      expected: ["\u8dd1\u817f\u5927\u5385"],
      forbidden: ["\u6211\u7684\u4efb\u52a1", "\u53d1\u5e03\u4efb\u52a1"],
    },
    {
      name: "services",
      path: "/services",
      expected: ["\u6280\u80fd\u670d\u52a1", "\u670d\u52a1\u5217\u8868"],
      forbidden: ["\u6211\u7684\u670d\u52a1", "\u53d1\u5e03\u670d\u52a1"],
    },
    {
      name: "login",
      path: "/login",
      expected: ["\u6b22\u8fce\u56de\u6765", "\u767b\u5f55\u6821\u56ed\u96c6\u5e02"],
    },
    {
      name: "register",
      path: "/register",
      expected: ["\u521b\u5efa\u8d26\u53f7", "\u6ce8\u518c\u6821\u56ed\u96c6\u5e02"],
    },
    {
      name: "search",
      path: `/search?q=${encodeURIComponent(product.title)}`,
      expected: ["\u5168\u7ad9\u641c\u7d22", product.title],
    },
    {
      name: "product-detail",
      path: `/products/${product.id}`,
      expected: [
        product.title,
        "\u5356\u5bb6\u4fe1\u606f",
        "\u4e3a\u4f60\u63a8\u8350",
      ],
    },
    {
      name: "errand-detail",
      path: `/errands/${errand.id}`,
      expected: [
        errand.title,
        "\u53d1\u5e03\u8005\u4fe1\u606f",
        "\u4efb\u52a1\u8981\u6c42",
      ],
    },
    {
      name: "service-detail",
      path: `/services/${service.id}`,
      expected: [
        service.title,
        "\u670d\u52a1\u8005\u4fe1\u606f",
        "\u4e3a\u4f60\u63a8\u8350\u540c\u6821\u6280\u80fd\u670d\u52a1",
      ],
    },
    {
      name: "public-user",
      path: `/users/${user.id}`,
      expected: [
        user.name,
        "Ta \u53d1\u5e03\u7684\u95f2\u7f6e\u5546\u54c1",
        "Ta \u4e0a\u67b6\u7684\u6280\u80fd\u670d\u52a1",
      ],
    },
    {
      name: "rules",
      path: "/rules",
      expected: ["\u5e73\u53f0\u89c4\u5219", "\u7981\u6b62\u5185\u5bb9"],
    },
  ];

  const results: Array<{ name: string; url: string; status: number }> = [];

  for (const check of checks) {
    const { url, response, html } = await fetchPage(check.path);
    assert(response.ok, `${check.name} request failed: ${response.status} ${response.statusText}`);

    for (const expectedText of check.expected) {
      assert(html.includes(expectedText), `${check.name} missing expected text: ${expectedText}`);
    }
    for (const forbiddenText of check.forbidden ?? []) {
      assert(!html.includes(forbiddenText), `${check.name} should not expose guest text: ${forbiddenText}`);
    }

    results.push({
      name: check.name,
      url,
      status: response.status,
    });
  }

  // 列表段 loading.tsx 会让响应 shell 以 200 先行 flush，
  // notFound() 只能流式替换为 not-found UI（框架语义）。
  // 因此这里断言 not-found UI 的渲染，真正的 404 状态码由未知路由检查覆盖。
  const missingProduct = await fetchPage("/products/missing-product-id");
  for (const expectedText of ["页面不存在", "链接可能已经失效", "浏览二手商品", "进入个人中心"]) {
    assert(
      missingProduct.html.includes(expectedText),
      `missing product page missing expected text: ${expectedText}`,
    );
  }
  results.push({
    name: "missing-product",
    url: missingProduct.url,
    status: missingProduct.response.status,
  });

  const unknownRoute = await fetchPage("/definitely-not-a-route");
  assert(
    unknownRoute.response.status === 404,
    `unknown route should return 404, got ${unknownRoute.response.status}`,
  );
  results.push({
    name: "unknown-route",
    url: unknownRoute.url,
    status: unknownRoute.response.status,
  });

  console.log("Runtime page verification passed.");
  console.log(
    JSON.stringify(
      {
        baseUrl,
        checked: results,
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
