import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getMyErrandFavorites } from "@/actions/errand-favorite";

export async function GET() {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const favorites = await getMyErrandFavorites(session.user.id);

    return NextResponse.json({ favorites });
  } catch (error) {
    console.error("Error fetching errand favorites:", error);
    return NextResponse.json(
      { error: "Failed to fetch favorites" },
      { status: 500 }
    );
  }
}
