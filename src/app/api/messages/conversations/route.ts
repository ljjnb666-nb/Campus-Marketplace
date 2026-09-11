import { NextResponse } from "next/server";
import { getVerifiedSession } from "@/lib/server-auth";
import { handleError } from "@/lib/error-handler";
import { getConversationListItems } from "@/repositories/conversation-repository";
import { withHttpMetrics } from "@/lib/http-metrics";

export const dynamic = "force-dynamic";

async function getHandler(request: Request) {
  try {
    // Phase 6C-2 raw-auth hardening：私有会话列表必须 ACTIVE 账号 DB 复查
    //（401 体契约保持 { items: [] } 原状）
    const verified = await getVerifiedSession();

    if (!verified.ok) {
      return NextResponse.json({ items: [] }, { status: 401 });
    }

    const limitParam = Number(new URL(request.url).searchParams.get("limit"));
    const items = await getConversationListItems(verified.user.id, {
      limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined,
    });

    return NextResponse.json({ items });
  } catch (error) {
    const handled = handleError(error, "GET /api/messages/conversations");
    return NextResponse.json({ message: handled.message }, { status: handled.statusCode });
  }
}

export const GET = withHttpMetrics("messages/conversations", getHandler);
