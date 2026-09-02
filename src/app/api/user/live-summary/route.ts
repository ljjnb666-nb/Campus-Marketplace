import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { handleError } from "@/lib/error-handler";
import { getUnreadConversationCount } from "@/repositories/conversation-repository";
import { getUnreadNotificationCount } from "@/repositories/notification-repository";
import { withHttpMetrics } from "@/lib/http-metrics";

export const dynamic = "force-dynamic";

async function getHandler() {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        {
          unreadNotifications: 0,
          unreadConversations: 0,
        },
        { status: 401 },
      );
    }

    const [unreadNotifications, unreadConversations] = await Promise.all([
      getUnreadNotificationCount(session.user.id),
      getUnreadConversationCount(session.user.id),
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
