import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { handleError } from "@/lib/error-handler";
import { getUnreadConversationCount } from "@/repositories/conversation-repository";
import { getUnreadNotificationCount } from "@/repositories/notification-repository";

export const dynamic = "force-dynamic";

export async function GET() {
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
