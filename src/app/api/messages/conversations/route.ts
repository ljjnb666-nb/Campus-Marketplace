import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getConversationListItems } from "@/repositories/conversation-repository";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ items: [] }, { status: 401 });
  }

  const items = await getConversationListItems(session.user.id);

  return NextResponse.json({ items });
}
