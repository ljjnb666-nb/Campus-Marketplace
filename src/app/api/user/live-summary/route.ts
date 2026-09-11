import { NextResponse } from "next/server";
import { getVerifiedSession } from "@/lib/server-auth";
import { handleError } from "@/lib/error-handler";
import { getUnreadConversationCount } from "@/repositories/conversation-repository";
import { getUnreadNotificationCount } from "@/repositories/notification-repository";
import { withHttpMetrics } from "@/lib/http-metrics";

export const dynamic = "force-dynamic";

async function getHandler() {
  try {
    // Phase 6C-2 raw-auth hardening：私有未读计数必须 ACTIVE 账号 DB 复查
    //（401 零计数体契约保持原状）
    const verified = await getVerifiedSession();

    if (!verified.ok) {
      return NextResponse.json(
        {
          unreadNotifications: 0,
          unreadConversations: 0,
        },
        { status: 401 },
      );
    }

    const [unreadNotifications, unreadConversations] = await Promise.all([
      getUnreadNotificationCount(verified.user.id),
      getUnreadConversationCount(verified.user.id),
    ]);

    return NextResponse.json({
      unreadNotifications,
      unreadConversations,
    });
  } catch (error) {
    const handled = handleError(error, "GET /api/user/live-summary");
    return NextResponse.json(
      { message: handled.message },
      { status: handled.statusCode },
    );
  }
}

export const GET = withHttpMetrics("user/live-summary", getHandler);
