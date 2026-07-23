import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getConversationDetailPayload } from "@/repositories/conversation-repository";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const payload = await getConversationDetailPayload(id, session.user.id);

  return NextResponse.json(payload);
}
