import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function requireUser() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, role: true, email: true, name: true, avatarUrl: true, verificationStatus: true, status: true, deletedAt: true },
  });

  // 每次请求都对照数据库最新状态：账号被停用或删除后立即失效旧会话
  if (!dbUser || dbUser.status !== "ACTIVE" || dbUser.deletedAt) {
    redirect("/login");
  }

  return {
    ...session.user,
    ...dbUser,
  };
}

export async function requireAdmin() {
  const user = await requireUser();

  if (user.role !== "ADMIN") {
    redirect("/");
  }

  return user;
}
