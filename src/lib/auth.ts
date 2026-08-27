import { compare } from "bcryptjs";
import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { isRateLimited, resetRateLimit } from "@/lib/rate-limit";

const LOGIN_RATE_LIMIT = 10;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

function resolveClientIp(headers: Record<string, unknown> | undefined) {
  const forwardedFor = headers?.["x-forwarded-for"];
  const headerValue = Array.isArray(forwardedFor)
    ? forwardedFor.join(",")
    : forwardedFor;

  if (typeof headerValue === "string") {
    const ip = headerValue.split(",")[0]?.trim();
    if (ip) {
      return ip;
    }
  }

  return "unknown";
}

function resolveLoginRateLimitKey(
  credentials: Record<string, string> | undefined,
  headers: Record<string, unknown> | undefined,
) {
  const identifier = credentials?.email?.trim().toLowerCase();

  return `login:${identifier || resolveClientIp(headers)}`;
}

export const authOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
    maxAge: 7 * 24 * 60 * 60,   // 7 天（缩短默认的 30 天，降低会话固定攻击窗口）
    updateAge: 24 * 60 * 60,    // 每 24 小时刷新 JWT
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "邮箱", type: "email" },
        password: { label: "密码", type: "password" },
      },
      async authorize(credentials, req) {
        const rateLimitKey = resolveLoginRateLimitKey(
          credentials,
          req?.headers,
        );

        const { limited } = await isRateLimited({
          key: rateLimitKey,
          limit: LOGIN_RATE_LIMIT,
          windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
        });

        if (limited) {
          // 与密码错误同样返回 null，不向客户端泄露限流状态
          logger.warn("登录限流触发", "auth", { rateLimitKey });
          return null;
        }

        const parsed = credentialsSchema.safeParse(credentials);

        if (!parsed.success) {
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email },
        });

        if (!user || user.deletedAt || user.status !== "ACTIVE") {
          return null;
        }

        const isValid = await compare(parsed.data.password, user.passwordHash);

        if (!isValid) {
          return null;
        }

        await prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        });

        // 登录成功后重置该账号的失败计数
        await resetRateLimit(rateLimitKey);

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.avatarUrl,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      const typedUser = user as
        | {
            id: string;
            name?: string | null;
            image?: string | null;
            role?: "STUDENT" | "ADMIN";
          }
        | undefined;

      if (typedUser) {
        token.id = typedUser.id;
        token.name = typedUser.name;
        token.picture = typedUser.image;
        token.role = typedUser.role ?? "STUDENT";
      }

      if (trigger === "update" && session) {
        if (typeof session.name === "string" || session.name === null) {
          token.name = session.name;
        }

        if (typeof session.image === "string" || session.image === null) {
          token.picture = session.image;
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.id as string | undefined) ?? session.user.id;
        session.user.name = (token.name as string | null | undefined) ?? null;
        session.user.image = (token.picture as string | null | undefined) ?? null;
        session.user.role =
          (token.role as "STUDENT" | "ADMIN" | undefined) ?? "STUDENT";
      }

      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};

export function auth() {
  return getServerSession(authOptions);
}
