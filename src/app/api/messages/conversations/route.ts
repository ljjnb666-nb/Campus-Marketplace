import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { handleError } from "@/lib/error-handler";
import { getConversationListItems } from "@/repositories/conversation-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json({ items: [] }, { status: 401 });
    }

    const limitParam = Number(new URL(request.url).searchParams.get("limit"));
    const items = await getConversationListItems(session.user.id, {
      limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined,
    });

    return NextResponse.json({ items });
  } catch (error) {
    const handled = handleError(error, "GET /api/messages/conversations");
    return NextResponse.json({ message: handled.message }, { status: handled.statusCode });
  }
}
