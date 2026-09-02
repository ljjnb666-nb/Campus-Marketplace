import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withHttpMetrics } from "@/lib/http-metrics";
import { handleError } from "@/lib/error-handler";
import { getConversationDetailPayload } from "@/repositories/conversation-repository";

export const dynamic = "force-dynamic";

async function getHandler(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const payload = await getConversationDetailPayload(id, session.user.id);

    if (!payload) {
      return NextResponse.json({ message: "会话不存在或无权访问" }, { status: 404 });
    }

    return NextResponse.json(payload);
  } catch (error) {
    const handled = handleError(error, "GET /api/messages/conversations/[id]");
    return NextResponse.json({ message: handled.message }, { status: handled.statusCode });
  }
}

export const GET = withHttpMetrics("messages/conversations/:id", getHandler);
