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
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function mergeCookies(existing: string, incoming: string[]) {
  const store = new Map<string, string>();

  for (const part of existing.split(/;\s*/).filter(Boolean)) {
    const [name, ...rest] = part.split("=");
    store.set(name, rest.join("="));
  }

  for (const cookie of incoming) {
    const [pair] = cookie.split(";");
    const [name, ...rest] = pair.split("=");
    store.set(name, rest.join("="));
  }

  return Array.from(store.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function fetchWithCookies(path: string, cookieHeader = "", init?: RequestInit) {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "user-agent": "campus-marketplace-auth-runtime-verify",
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(init?.headers ?? {}),
    },
    redirect: "manual",
  });

  const html = await response.text();
  const setCookies = response.headers.getSetCookie();
  const nextCookies = setCookies.length > 0 ? mergeCookies(cookieHeader, setCookies) : cookieHeader;

  return { url, response, html, cookies: nextCookies };
}

async function signIn(email: string, password: string) {
  const csrfResponse = await fetchWithCookies("/api/auth/csrf");
  assert(csrfResponse.response.ok, `csrf request failed: ${csrfResponse.response.status}`);

  const csrfPayload = JSON.parse(csrfResponse.html) as { csrfToken?: string };
  assert(csrfPayload.csrfToken, "Missing csrf token");

  const body = new URLSearchParams({
    csrfToken: csrfPayload.csrfToken,
    email,
    password,
    callbackUrl: `${baseUrl}/profile`,
    json: "true",
  });

  const signInResponse = await fetchWithCookies(
    "/api/auth/callback/credentials",
    csrfResponse.cookies,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );

  assert(
    signInResponse.response.status === 200 || signInResponse.response.status === 302,
    `sign in failed: ${signInResponse.response.status}`,
  );

  return signInResponse.cookies;
}

async function main() {
  const user = await prisma.user.findFirst({
    where: {
      role: "STUDENT",
      deletedAt: null,
      status: "ACTIVE",
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
    },
  });

  assert(user, "Missing active student for auth runtime verification");

  const cookies = await signIn(user.email, "Student123456");
  assert(cookies.includes("next-auth"), "Missing next-auth session cookie after sign in");

  const checks: Check[] = [
    {
      name: "profile",
      path: "/profile",
      expected: [user.name, "\u6821\u56ed\u8ba4\u8bc1", "\u7f16\u8f91\u4e2a\u4eba\u8d44\u6599"],
    },
    {
      name: "my-orders",
      path: "/my/orders",
      expected: ["\u6211\u7684\u8ba2\u5355", "\u6211\u53d1\u8d77\u7684\u8ba2\u5355"],
    },
    {
      name: "messages",
      path: "/messages",
      expected: ["\u6211\u7684\u4f1a\u8bdd"],
    },
    {
      name: "notifications",
      path: "/notifications",
      expected: ["\u6211\u7684\u901a\u77e5"],
    },
    {
      name: "my-products",
      path: "/my/products",
      expected: ["\u6211\u7684\u53d1\u5e03"],
    },
    {
      name: "my-services",
      path: "/my/services",
      expected: ["\u6211\u7684\u670d\u52a1"],
    },
    {
      name: "my-errands",
      path: "/my/errands",
      expected: ["\u6211\u7684\u4efb\u52a1"],
    },
    {
      name: "verification",
      path: "/verification",
      expected: ["\u6821\u56ed\u8ba4\u8bc1", "\u63d0\u4ea4\u8ba4\u8bc1\u6750\u6599"],
    },
  ];

  const results: Array<{ name: string; url: string; status: number }> = [];

  for (const check of checks) {
    const { url, response, html } = await fetchWithCookies(check.path, cookies);
    assert(response.status === 200, `${check.name} request failed: ${response.status}`);

    for (const expectedText of check.expected) {
      assert(html.includes(expectedText), `${check.name} missing expected text: ${expectedText}`);
    }

    results.push({
      name: check.name,
      url,
      status: response.status,
    });
  }

  console.log("Authenticated runtime page verification passed.");
  console.log(
    JSON.stringify(
      {
        baseUrl,
        user: {
          id: user.id,
          email: user.email,
        },
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
