import { compare } from "bcryptjs";
import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const authOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
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
      async authorize(credentials) {
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
